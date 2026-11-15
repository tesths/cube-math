/**
 * 正方体三视图 · 课堂服务器
 *
 * 零运行时依赖，只用 Node 内置模块：
 *   - 静态文件服务（public/，含 vendor 到本地的 three.js）
 *   - GET  /api/state            全部小组当前状态
 *   - GET  /api/events           SSE 推送（学生一改，教师端秒同步）
 *   - POST /api/groups/:group    学生提交本组方块
 *   - GET  /healthz              健康检查（Railway / 容器平台用）
 *
 * 部署：
 *   Railway / 自己的服务器 / 本地  → npm start（本文件）
 *   Vercel                        → 静态站点 + api/ 目录下的函数（见 README）
 *
 * 环境变量：PORT、HOST、DATA_DIR、CORS_ORIGIN（前后端分开部署时用）
 */
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { sanitizeCubes, validateCubes, LIMITS } from './public/js/shared/model.js';
import { createStore, GROUP_COUNT, storeKind, normalizeMode } from './lib/store.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');

const PORT = Number(process.env.PORT || 5173);
const HOST = process.env.HOST || '0.0.0.0';
const MAX_BODY = 512 * 1024;
/** 前后端分开部署（前端 Vercel + 后端 Railway）时需要；默认放开只读接口的跨域 */
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

// ---------------------------------------------------------------- 状态

const store = createStore();
await store.init();

async function snapshot() {
  return {
    serverTime: Date.now(),
    limits: LIMITS,
    groupCount: GROUP_COUNT,
    groups: await store.getAll(),
  };
}

// ---------------------------------------------------------------- SSE

/** @type {Set<import('node:http').ServerResponse>} */
const clients = new Set();

function sseSend(res, event, payload) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

async function broadcast() {
  if (clients.size === 0) return;
  const data = await snapshot();
  for (const res of clients) {
    try {
      if (res.writableEnded || res.destroyed) {
        clients.delete(res);
        continue;
      }
      sseSend(res, 'state', data);
    } catch {
      clients.delete(res);
    }
  }
}

// ---------------------------------------------------------------- 工具

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': CORS_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': MIME['.json'],
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    ...corsHeaders(),
  });
  res.end(text);
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('请求体过大'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  if (rel === '/teacher' || rel === '/teacher/') rel = '/teacher.html';
  if (rel === '/settings' || rel === '/settings/') rel = '/settings.html';

  const filePath = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    return json(res, 403, { error: 'forbidden' });
  }

  try {
    const stat = await fsp.stat(filePath);
    if (stat.isDirectory()) return json(res, 404, { error: 'not found' });
    const ext = path.extname(filePath).toLowerCase();
    // 一律 no-cache：局域网教学工具改一版代码，学生机刷新就该拿到新的
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(filePath).pipe(res);
  } catch {
    res.writeHead(404, { 'Content-Type': MIME['.html'] });
    res.end('<meta charset="utf-8"><h1>404</h1><p><a href="/">回学生端</a> ｜ <a href="/teacher">去教师端</a></p>');
  }
}

/** 校验并写入某一组；返回 { ok, entry, status, error } */
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
  const entry = await store.setGroup(id, cubes, body?.task);
  broadcast();
  return { ok: true, status: 200, entry };
}

// ---------------------------------------------------------------- 路由

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const { pathname } = url;

  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders());
      return res.end();
    }

    if (pathname === '/healthz') {
      return json(res, 200, { ok: true, groups: GROUP_COUNT, store: storeKind() });
    }

    if (pathname === '/api/state' && req.method === 'GET') {
      return json(res, 200, await snapshot());
    }

    if (pathname === '/api/settings') {
      if (req.method === 'GET') {
        return json(res, 200, await store.getSettings());
      }
      if (req.method === 'POST') {
        const raw = await readBody(req);
        let body = {};
        if (raw.trim()) {
          try {
            body = JSON.parse(raw);
          } catch {
            return json(res, 400, { error: 'JSON 解析失败' });
          }
        }
        if (body?.mode !== 'training' && body?.mode !== 'formal') {
          return json(res, 400, { error: "mode 只能是 'training' 或 'formal'" });
        }
        const next = await store.setSettings(normalizeMode(body.mode));
        return json(res, 200, next);
      }
      return json(res, 405, { error: 'method not allowed' });
    }

    if (pathname === '/api/events' && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
        ...corsHeaders(),
      });
      res.write('retry: 2000\n\n');
      clients.add(res);
      sseSend(res, 'state', await snapshot());

      const ping = setInterval(() => {
        try { res.write(': ping\n\n'); } catch { /* 断开时由 close 处理 */ }
      }, 25000);

      req.on('close', () => {
        clearInterval(ping);
        clients.delete(res);
      });
      return undefined;
    }

    const post = pathname.match(/^\/api\/groups\/(\d+)(\/clear)?$/);
    if (post && req.method === 'POST') {
      const raw = await readBody(req);
      let body = {};
      if (raw.trim()) {
        try {
          body = JSON.parse(raw);
        } catch {
          return json(res, 400, { error: 'JSON 解析失败' });
        }
      }
      const result = await applyGroup(Number(post[1]), body, { clear: Boolean(post[2]) });
      return json(res, result.status, result.ok ? result.entry : { error: result.error });
    }

    if (pathname.startsWith('/api/')) {
      return json(res, 404, { error: 'unknown api' });
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return json(res, 405, { error: 'method not allowed' });
    }

    return await serveStatic(req, res, pathname);
  } catch (err) {
    console.error('请求处理失败：', err);
    return json(res, err.statusCode || 500, { error: err.message || 'server error' });
  }
});

// ---------------------------------------------------------------- 启动

function lanAddresses() {
  const list = [];
  for (const infos of Object.values(os.networkInterfaces())) {
    for (const info of infos ?? []) {
      if (info.family === 'IPv4' && !info.internal) list.push(info.address);
    }
  }
  return list;
}

server.listen(PORT, HOST, () => {
  console.log('\n正方体三视图 · 课堂服务器已启动\n');
  console.log('  本机     学生端  http://localhost:' + PORT + '/');
  console.log('  本机     教师端  http://localhost:' + PORT + '/teacher');
  for (const ip of lanAddresses()) {
    console.log(`  局域网   学生端  http://${ip}:${PORT}/`);
    console.log(`  局域网   教师端  http://${ip}:${PORT}/teacher`);
  }
  console.log('\n  学生机和教师机请访问上面「局域网」那条地址（Ctrl+C 停止）\n');
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    try { await store.close?.(); } catch { /* 退出时尽力保存 */ }
    console.log('\n数据已保存，服务器停止。');
    process.exit(0);
  });
}
