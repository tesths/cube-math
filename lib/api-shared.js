/**
 * Vercel 无服务器函数共用的小工具。
 * 逻辑与 server.js 保持一致：校验 + 写入存储；区别只是没有 SSE（HTTP 长连接）。
 *
 * 另外这里放了几件无服务器特有的加固：
 *   - CORS / OPTIONS 预检（前端可能部署在别的域名）
 *   - /api/state 的 ETag + If-None-Match → 304（9 台设备每 2 秒轮询，304 能省掉响应体）
 *   - 请求体大小上限（防止误传超大 JSON 拖垮函数）
 */
import { createHash } from 'node:crypto';
import { createStore, GROUP_COUNT } from './store.js';
import { sanitizeCubes, validateCubes, normalizeTask, LIMITS } from '../public/js/shared/model.js';

/** 与 server.js 的 MAX_BODY 保持一致：512KB 足够 10 个组 × 125 个方块 */
export const MAX_BODY_BYTES = 512 * 1024;

let storePromise = null;
function getStore() {
  if (!storePromise) {
    storePromise = (async () => {
      const store = createStore();
      await store.init();
      return store;
    })();
  }
  return storePromise;
}

export function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, OPTIONS');
  // 允许前端读取 ETag（同源不需要，前后端分开部署时需要）
  res.setHeader('Access-Control-Expose-Headers', 'ETag, X-SSE-Unavailable');
  // If-None-Match 是自定义请求头，跨域时会触发预检，必须显式放行
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, If-None-Match');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Vary', 'Origin');
}

export async function snapshot() {
  const store = await getStore();
  return {
    serverTime: Date.now(),
    limits: LIMITS,
    groupCount: GROUP_COUNT,
    groups: await store.getAll(),
  };
}

export async function applyGroup(id, body, { clear = false } = {}) {
  if (!Number.isInteger(id) || id < 1 || id > GROUP_COUNT) {
    return { ok: false, status: 404, error: `没有第 ${id} 组（只支持 1..${GROUP_COUNT}）` };
  }
  if (!clear && !Array.isArray(body?.cubes)) {
    return { ok: false, status: 400, error: 'cubes 必须是数组' };
  }
  const incoming = clear ? [] : body.cubes;
  const errors = validateCubes(incoming);
  if (errors.length) return { ok: false, status: 400, error: errors.join('；') };

  const { cubes } = sanitizeCubes(incoming);
  const store = await getStore();
  const entry = await store.setGroup(id, cubes, body?.task);
  return { ok: true, status: 200, entry };
}

/** 读全局设置（模式：training/formal） */
export async function readSettings() {
  const store = await getStore();
  return store.getSettings();
}

/** 写全局设置 */
export async function writeSettings(mode) {
  const store = await getStore();
  return store.setSettings(mode);
}

export function preflight(req, res) {
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return true;
  }
  return false;
}

/**
 * 把 `req.query.group`（字符串 / 字符串数组 / undefined）转成组号。
 * 不是合法正整数就返回 NaN —— 交给 applyGroup 统一回 404，避免把 "3abc" 当成 3。
 */
export function groupId(raw) {
  if (Array.isArray(raw)) return NaN;      // ?group=1&group=2 这种不确定的写法直接拒绝
  if (raw === undefined || raw === null || raw === '') return NaN;
  const text = String(raw).trim();
  if (!/^\d+$/.test(text)) return NaN;
  return Number(text);
}

/**
 * 基于真实数据算 ETag：每组的 updatedAt + 当前 task + 三个任务槽的方块。
 * 不使用随机数、也不包含 serverTime（时间每次请求都变，会让 ETag 永远失效）。
 * 注意：必须包含 task / tasks —— 只算 updatedAt 时，task 或某槽内容变化可能命中
 * 旧的 304（客户端复用上一条 lastState），导致轮询端看到过期状态。
 */
export function etagFor(groups) {
  const hash = createHash('sha1');
  hash.update(`v2:${GROUP_COUNT}`);
  for (const g of groups ?? []) {
    hash.update(`|${g.group}:${Number(g.updatedAt) || 0}:${normalizeTask(g.task)}:`);
    hash.update(JSON.stringify(g.tasks ?? g.cubes ?? []));
  }
  return `W/"${hash.digest('base64url').slice(0, 22)}"`;
}

/**
 * 解析 If-None-Match：支持 `*`、`W/"x"`、以及逗号分隔的多个标签。
 * 命中返回 true（可以回 304）。
 */
export function isFresh(req, etag) {
  const header = req?.headers?.['if-none-match'];
  if (!header) return false;
  const strip = (tag) => String(tag).trim().replace(/^W\//i, '');
  const wanted = strip(etag);
  return String(header)
    .split(',')
    .map(strip)
    .some((tag) => tag === '*' || tag === wanted);
}

/**
 * GET /api/state 的完整响应：先算 ETag，命中缓存就 304，否则 200 + JSON。
 * 304 只回响应头，能省掉每个 2 秒轮询的响应体。
 */
export async function sendState(req, res) {
  const data = await snapshot();
  const etag = etagFor(data.groups);
  res.setHeader('ETag', etag);
  if (isFresh(req, etag)) {
    res.status(304).end();
    return;
  }
  res.status(200).json(data);
}

export async function readJsonBody(req) {
  // Vercel / 本地测试通常已经把 JSON 解析成对象了
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  // 少数运行时会给出字符串或 Buffer，这里也兼容一下
  if (typeof req.body === 'string' || Buffer.isBuffer(req.body)) {
    const text = String(req.body).trim();
    return text ? JSON.parse(text) : {};
  }
  const declared = Number(req.headers?.['content-length']);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    const err = new Error('请求体过大');
    err.code = 'BODY_TOO_LARGE';
    throw err;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const err = new Error('请求体过大');
      err.code = 'BODY_TOO_LARGE';
      throw err;
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw.trim() ? JSON.parse(raw) : {};
}