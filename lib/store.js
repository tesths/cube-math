/**
 * 状态存储层：把"8 个组长什么样"这件事和"存在哪里"解耦。
 *
 * 三种后端，按环境变量自动选择：
 *   1. RedisStore  —— 配了 Redis REST 变量时使用（两套变量名都认）：
 *                      UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN
 *                      KV_REST_API_URL       / KV_REST_API_TOKEN
 *                      适合 Vercel 这类无服务器环境（没有可写磁盘，实例之间也不共享内存）。
 *   2. FileStore   —— 本地 / Railway / 自己的服务器：写 data/state.json，重启不丢。
 *   3. MemoryStore —— 兜底：进程内存，重启即丢（Vercel 上没配 Redis 时会走到这里）。
 *
 * 无服务器加固：
 *   - 每个 Redis 请求都有超时（默认 3 秒，可用 REDIS_TIMEOUT_MS 调整），不会把函数拖到超时；
 *   - Redis 报错 / 超时不再往上抛，而是「降级为进程内存 + 只 warn 一次」，课堂不会因为
 *     Redis 抖一下就整站 500；
 *   - 降级后每 30 秒尝试恢复一次，成功后自动切回 Redis。
 *
 * 所有方法都是异步的，Node 服务器与 serverless 函数共用同一套接口。
 * ⚠ server.js 依赖本文件的导出与签名（createStore / GROUP_COUNT / FileStore /
 *   MemoryStore / RedisStore / normalizeGroups / emptyGroups / emptyGroup），不要改名。
 */
import fsp from 'node:fs/promises';
import { taskInitial, normalizeTask } from '../public/js/shared/model.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const GROUP_COUNT = 8;

/** 全局设置（所有设备共享）在 Redis 里的键名 */
const SETTINGS_KEY = 'cube-views:settings';

/** 设置里的模式：training=只显示任务0（练习） formal=任务1·2·3（正式） */
export function normalizeMode(value) {
  return value === 'training' ? 'training' : 'formal';
}

export function normalizeSettings(raw) {
  const mode = normalizeMode(raw && typeof raw === 'object' ? raw.mode : raw);
  return { mode, updatedAt: Number(raw && raw.updatedAt) || 0 };
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Redis 单次请求超时（毫秒）。Vercel 函数默认 10 秒上限，3 秒足够并且留足余量。 */
const DEFAULT_REDIS_TIMEOUT_MS = 3000;
/** 降级后多久再试一次 Redis */
const REDIS_RETRY_INTERVAL_MS = 30_000;

/** 三个任务各自的初始图形 */
export function taskSlotsEmpty() {
  return { 1: taskInitial(1), 2: taskInitial(2), 3: taskInitial(3) };
}

/** 只保留合法坐标；数组本身为空是合法的（任务二可以拿光） */
function cleanCubes(list, fallback) {
  if (!Array.isArray(list)) return fallback.map((c) => [...c]);
  return list
    .filter((c) => Array.isArray(c) && c.length >= 3)
    .map((c) => [Number(c[0]), Number(c[1]), Number(c[2])])
    .filter(([x, y, z]) => [x, y, z].every((n) => Number.isInteger(n) && n >= 0 && n < 5));
}

export function emptyGroup(group) {
  return { group, task: 1, tasks: taskSlotsEmpty(), updatedAt: 0 };
}

export function emptyGroups() {
  return Array.from({ length: GROUP_COUNT }, (_, i) => emptyGroup(i + 1));
}

function cloneCubes(list) {
  return (list ?? []).map((c) => [...c]);
}

function snapshotGroup(g) {
  return {
    group: g.group,
    task: g.task,
    tasks: { 1: cloneCubes(g.tasks?.[1]), 2: cloneCubes(g.tasks?.[2]), 3: cloneCubes(g.tasks?.[3]) },
    updatedAt: g.updatedAt,
  };
}

/** 只替换"当前任务的这一槽"，另外两个任务的进度原样保留 */
function buildEntry(id, prev, cubes, task) {
  const t = normalizeTask(task);
  const tasks = {
    1: cloneCubes(prev?.tasks?.[1] ?? taskInitial(1)),
    2: cloneCubes(prev?.tasks?.[2] ?? taskInitial(2)),
    3: cloneCubes(prev?.tasks?.[3] ?? taskInitial(3)),
  };
  tasks[t] = cloneCubes(cubes);
  return { group: id, task: t, tasks, updatedAt: Date.now() };
}

/** 把外部读到的数据整理成安全的 8 组结构 */
export function normalizeGroups(raw) {
  const byGroup = new Map();
  for (const item of Array.isArray(raw) ? raw : []) {
    const id = Number(item?.group);
    if (!Number.isInteger(id) || id < 1 || id > GROUP_COUNT) continue;
    const task = normalizeTask(item?.task);
    const tasks = taskSlotsEmpty();
    if (item?.tasks && typeof item.tasks === 'object') {
      for (const k of [1, 2, 3]) {
        if (item.tasks[k] !== undefined) tasks[k] = cleanCubes(item.tasks[k], taskInitial(k));
      }
    } else if (Array.isArray(item?.cubes)) {
      // 旧数据（只有一份 cubes）：放进它当时标注的任务槽，其它任务用初始图形
      tasks[task] = cleanCubes(item.cubes, taskInitial(task));
    }
    byGroup.set(id, { group: id, task, tasks, updatedAt: Number(item?.updatedAt) || 0 });
  }
  return emptyGroups().map((g) => byGroup.get(g.group) ?? g);
}

// ---------------------------------------------------------------- 内存

export class MemoryStore {
  constructor() {
    this.kind = 'memory';
    this.groups = emptyGroups();
    this.settings = normalizeSettings(null);
  }

  async init() {}

  async getAll() {
    return this._snapshot();
  }

  _snapshot() {
    return this.groups.map(snapshotGroup);
  }

  async setGroup(id, cubes, task) {
    const entry = buildEntry(id, this.groups[id - 1], cubes, task);
    this.groups[id - 1] = entry;
    return entry;
  }

  async getSettings() {
    return { ...this.settings };
  }

  async setSettings(mode) {
    this.settings = { mode: normalizeMode(mode), updatedAt: Date.now() };
    return { ...this.settings };
  }
}

// ---------------------------------------------------------------- 文件（本地 / Railway）

export class FileStore {
  constructor(dataDir = process.env.DATA_DIR || path.join(ROOT, 'data')) {
    this.kind = 'file';
    this.dir = dataDir;
    this.file = path.join(dataDir, 'state.json');
    this.groups = emptyGroups();
    this.settings = normalizeSettings(null);
    this.saveTimer = null;
    this.pending = null;
  }

  async init() {
    try {
      const raw = await fsp.readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      this.groups = normalizeGroups(parsed?.groups);
      this.settings = normalizeSettings(parsed?.settings);
      const total = this.groups.reduce(
        (n, g) => n + [1, 2, 3].reduce((m, k) => m + (g.tasks?.[k]?.length ?? 0), 0),
        0,
      );
      console.log(`已恢复上次数据：${total} 个方块（${this.file}）`);
    } catch (err) {
      if (err.code !== 'ENOENT') console.warn('读取历史数据失败，按空状态启动：', err.message);
    }
  }

  async getAll() {
    return this.groups.map(snapshotGroup);
  }

  async setGroup(id, cubes, task) {
    const entry = buildEntry(id, this.groups[id - 1], cubes, task);
    this.groups[id - 1] = entry;
    this._scheduleSave();
    return entry;
  }

  async getSettings() {
    return { ...this.settings };
  }

  async setSettings(mode) {
    this.settings = { mode: normalizeMode(mode), updatedAt: Date.now() };
    this._scheduleSave();
    return { ...this.settings };
  }

  _scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.flush().catch((err) => console.error('落盘失败：', err.message));
    }, 400);
  }

  async flush() {
    if (this.pending) return this.pending;
    this.pending = (async () => {
      await fsp.mkdir(this.dir, { recursive: true });
      const tmp = `${this.file}.tmp`;
      const body = JSON.stringify({ groups: this.groups, settings: this.settings }, null, 2);
      await fsp.writeFile(tmp, body);
      await fsp.rename(tmp, this.file);   // 原子替换，避免读到写一半的文件
    })().finally(() => { this.pending = null; });
    return this.pending;
  }

  /** 进程退出前调用，保证最后一次改动落盘 */
  async close() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    await this.flush();
  }
}

// ---------------------------------------------------------------- Redis（Vercel / Upstash）

/**
 * Upstash REST 客户端（只用 fetch，零依赖）。
 *
 * 设计原则：课堂优先。
 *   - 读失败 → 用内存里最近一次成功的数据（而不是抛 500）；
 *   - 写失败 → 内存里记下来（同一实例后续轮询还能看到），并 warn 一次；
 *   - 所有请求带 AbortController 超时，避免函数挂到平台超时上限。
 */
export class RedisStore {
  constructor(url, token, { timeoutMs } = {}) {
    this.kind = 'redis';
    this.url = String(url || '').replace(/\/$/, '');
    this.token = token;
    this.timeoutMs = Number(timeoutMs) > 0 ? Number(timeoutMs) : DEFAULT_REDIS_TIMEOUT_MS;
    this.groups = emptyGroups();
    this.settings = normalizeSettings(null);
    this.degraded = false;
    this._warned = false;
    this._nextRetryAt = 0;
  }

  /** 发一条 Redis 命令；失败一律 throw，由调用方决定降级 */
  async _cmd(args) {
    if (!this.url || !this.token) throw new Error('缺少 Redis URL / TOKEN');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(this.url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(args),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = (await res.text().catch(() => '')).slice(0, 200);
        throw new Error(`Redis ${res.status}: ${text}`);
      }
      let body;
      try {
        body = await res.json();
      } catch {
        throw new Error('Redis 返回的不是 JSON');
      }
      if (body?.error) throw new Error(`Redis: ${body.error}`);
      return body?.result;
    } catch (err) {
      if (err?.name === 'AbortError' || err?.name === 'TimeoutError') {
        throw new Error(`Redis 请求超时（${this.timeoutMs}ms）`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  _key(group) {
    return `cube-views:g${group}`;
  }

  _snapshot() {
    return this.groups.map(snapshotGroup);
  }

  /** 进入降级模式：只 warn 一次，避免每 2 秒刷屏 */
  _degrade(err) {
    this.degraded = true;
    this._nextRetryAt = Date.now() + REDIS_RETRY_INTERVAL_MS;
    if (this._warned) return;
    this._warned = true;
    console.warn(
      `⚠ Redis 不可用（${err?.message || err}），已降级为进程内存存储：` +
      '多个实例之间不再共享状态，重新部署会丢失。请检查 UPSTASH_REDIS_REST_URL/TOKEN 或 KV_REST_API_URL/TOKEN。',
    );
  }

  /** 降级后每 30 秒试一次，恢复就切回 Redis（日志也只打一次） */
  async _maybeRecover() {
    if (!this.degraded || Date.now() < this._nextRetryAt) return;
    this._nextRetryAt = Date.now() + REDIS_RETRY_INTERVAL_MS;
    try {
      this.groups = await this._readAll();
      this.degraded = false;
      console.log('Redis 已恢复，切回 Redis 存储');
    } catch {
      /* 还不行就继续用内存，不再重复 warn */
    }
  }

  async init() {
    // 预热：把已有数据读进内存（读失败只降级，不影响服务启动）
    try {
      this.groups = await this._readAll();
      this.settings = await this._readSettings();
    } catch (err) {
      this._degrade(err);
    }
  }

  async _readSettings() {
    const raw = await this._cmd(['GET', SETTINGS_KEY]);
    if (!raw) return this.settings;
    try {
      return normalizeSettings(JSON.parse(raw));
    } catch {
      return this.settings;
    }
  }

  async _readAll() {
    const keys = Array.from({ length: GROUP_COUNT }, (_, i) => this._key(i + 1));
    const values = await this._cmd(['MGET', ...keys]);
    const groups = emptyGroups();
    (Array.isArray(values) ? values : []).forEach((raw, index) => {
      if (!raw) return;
      try {
        const parsed = JSON.parse(raw);
        groups[index] = normalizeGroups([{ ...parsed, group: index + 1 }])[index];
      } catch { /* 坏数据当空 */ }
    });
    return groups;
  }

  async getAll() {
    await this._maybeRecover();
    if (!this.degraded) {
      try {
        this.groups = await this._readAll();
      } catch (err) {
        this._degrade(err);
      }
    }
    return this._snapshot();
  }

  async setGroup(id, cubes, task) {
    const entry = buildEntry(id, this.groups[id - 1], cubes, task);
    // 先写内存：即使 Redis 这一下失败，本实例后续轮询也能看到刚提交的内容
    this.groups[id - 1] = entry;
    await this._maybeRecover();
    if (!this.degraded) {
      try {
        await this._cmd([
          'SET',
          this._key(id),
          JSON.stringify({ task: entry.task, tasks: entry.tasks, updatedAt: entry.updatedAt }),
        ]);
      } catch (err) {
        this._degrade(err);
      }
    }
    return entry;
  }

  async getSettings() {
    await this._maybeRecover();
    if (!this.degraded) {
      try {
        this.settings = await this._readSettings();
      } catch (err) {
        this._degrade(err);
      }
    }
    return { ...this.settings };
  }

  async setSettings(mode) {
    this.settings = { mode: normalizeMode(mode), updatedAt: Date.now() };
    await this._maybeRecover();
    if (!this.degraded) {
      try {
        await this._cmd(['SET', SETTINGS_KEY, JSON.stringify(this.settings)]);
      } catch (err) {
        this._degrade(err);
      }
    }
    return { ...this.settings };
  }
}

// ---------------------------------------------------------------- 工厂

/** 只判断会用哪种后端，不建立连接（给健康检查用） */
export function storeKind(env = process.env) {
  const redisUrl = env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL;
  const redisToken = env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN;
  if (redisUrl && redisToken) return 'redis';
  if (env.VERCEL) return 'memory';
  return 'file';
}

export function createStore(env = process.env) {
  // 两套变量名都支持：Upstash 直连 / Vercel Marketplace（KV_ 前缀）
  const redisUrl = env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL;
  const redisToken = env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN;
  const timeoutMs = Number(env.REDIS_TIMEOUT_MS) || undefined;

  if (redisUrl && redisToken) return new RedisStore(redisUrl, redisToken, { timeoutMs });
  if (redisUrl && !redisToken) {
    console.warn(
      '⚠ 检测到 Redis URL 但没有写权限的 TOKEN（KV_REST_API_TOKEN / UPSTASH_REDIS_REST_TOKEN），' +
      '读写都会失败，因此继续使用内存存储。',
    );
  }

  // Vercel 上没有可写磁盘：内存兜底，并明确告诉运维要配 Redis
  if (env.VERCEL) {
    console.warn(
      '⚠ 没有配置 UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN（或 KV_REST_API_URL / KV_REST_API_TOKEN），' +
      '当前使用进程内存存储：多个实例之间不共享、重新部署会清空。详见 DEPLOY.md。',
    );
    return new MemoryStore();
  }

  return new FileStore(env.DATA_DIR);
}