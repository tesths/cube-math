/**
 * 模拟"无服务器部署"（Vercel）联调验证。
 *
 * 本地起一个**没有 SSE** 的迷你服务器（/api/events 直接 204、/api/state 带 ETag 支持 304），
 * 然后真的用浏览器跑一遍：学生端移动方块 → 教师端靠 2 秒轮询看到变化 → 确认 304 被正确处理。
 *
 * 这验证的是 Vercel 那条链路的前端行为，不需要真的部署。
 *
 * 运行：node scripts/verify-serverless.mjs
 */
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { taskInitial } from '../public/js/shared/model.js';
import { fitDistance, projectNdc } from '../public/js/student/camera-fit.js';

import { loadBrowser } from './browser.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(root, 'public');
const PORT = Number(process.env.MOCK_PORT || 5199);
const BASE = `http://127.0.0.1:${PORT}`;

const errors = [];
const stats = { state200: 0, state304: 0, events204: 0 };

// ---------------------------------------------------------------- 假的无服务器后端

const mkTasks = () => ({ 1: taskInitial(1), 2: taskInitial(2), 3: taskInitial(3) });
const mkGroup = (i) => ({ group: i + 1, task: 1, tasks: mkTasks(), updatedAt: 0 });
let groups = Array.from({ length: 8 }, (_, i) => mkGroup(i));

// 把格子坐标换算成页面坐标（与 stage.js 的取景规则一致）
const FOV = 38;
const HOME_POLAR = (80 * Math.PI) / 180;
const HOME_AZIMUTH = (10 * Math.PI) / 180;
const DIR = [
  Math.sin(HOME_POLAR) * Math.sin(HOME_AZIMUTH),
  Math.cos(HOME_POLAR),
  Math.sin(HOME_POLAR) * Math.cos(HOME_AZIMUTH),
];
function screenOf(rect, cell, cubes, { ground = false } = {}) {
  const contentTop = (cubes ?? []).reduce((m, c) => Math.max(m, c[1] + 1), 0);
  const top = Math.max(3.2, contentTop + 0.9);
  const center = [0, top / 2 - top * 0.2, 0];
  const aspect = rect.width / rect.height;
  const distance = fitDistance({ fovDeg: FOV, aspect, center, dir: DIR, min: [-2.5, 0, -2.5], max: [2.5, top, 2.5] });
  const ndc = projectNdc({ point: [cell[0] - 2, ground ? 0.02 : cell[1] + 0.5, cell[2] - 2], center, dir: DIR, distance, fovDeg: FOV, aspect });
  return { x: rect.x + ((ndc.x + 1) / 2) * rect.width, y: rect.y + ((1 - ndc.y) / 2) * rect.height };
}

function stateBody() {
  return {
    serverTime: Date.now(),
    limits: { sizeX: 5, sizeY: 5, sizeZ: 5 },
    groupCount: 8,
    groups,
  };
}

function etagOf() {
  const basis = groups.map((g) => `${g.group}:${g.updatedAt}:${g.task}:${[1, 2, 3].map((k) => (g.tasks?.[k] ?? []).length).join('.')}`).join('|');
  return `"${crypto.createHash('sha1').update(basis).digest('hex').slice(0, 16)}"`;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, BASE);

  if (url.pathname === '/api/events') {
    stats.events204 += 1;
    res.writeHead(204, { 'Cache-Control': 'no-store', 'X-SSE-Unavailable': '1' });
    return res.end();
  }

  if (url.pathname === '/api/state') {
    const tag = etagOf();
    const inm = req.headers['if-none-match'];
    if (inm && inm.split(',').map((s) => s.trim()).includes(tag)) {
      stats.state304 += 1;
      res.writeHead(304, { ETag: tag, 'Cache-Control': 'no-store' });
      return res.end();
    }
    stats.state200 += 1;
    const body = JSON.stringify(stateBody());
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      ETag: tag,
      'Cache-Control': 'no-store',
    });
    return res.end(body);
  }

  const post = url.pathname.match(/^\/api\/groups\/(\d+)$/);
  if (post && req.method === 'POST') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    const id = Number(post[1]);
    const t = Number(body.task) || 1;
    const prev = groups[id - 1] ?? mkGroup(id - 1);
    const tasks = { 1: prev.tasks[1], 2: prev.tasks[2], 3: prev.tasks[3] };
    tasks[t] = body.cubes ?? [];
    groups[id - 1] = { group: id, task: t, tasks, updatedAt: Date.now() };
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(groups[id - 1]));
  }

  // 静态文件
  let rel = url.pathname === '/' ? '/index.html' : url.pathname;
  if (rel === '/teacher' || rel === '/teacher/') rel = '/teacher.html';
  const file = path.join(PUBLIC, path.normalize(rel));
  if (!file.startsWith(PUBLIC)) {
    res.writeHead(403);
    return res.end();
  }
  try {
    const stat = await fsp.stat(file);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(file).pipe(res);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
});

await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));
console.log(`模拟无服务器后端已启动：${BASE}（没有 SSE，只有轮询）\n`);

// ---------------------------------------------------------------- 浏览器

const { chromium, executablePath } = await loadBrowser();

const browser = await chromium.launch({ headless: true, executablePath });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });

function hook(page) {
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`[console] ${msg.text()}`);
  });
  page.on('pageerror', (err) => errors.push(`[pageerror] ${err.message}`));
  return page;
}

const student = hook(await ctx.newPage());
await student.goto(`${BASE}/?reset`, { waitUntil: 'load' });
await student.waitForTimeout(800);
await student.locator('#groupGrid button:has-text("第 3 组")').click();
await student.waitForTimeout(600);

const teacher = hook(await ctx.newPage());
await teacher.goto(`${BASE}/teacher`, { waitUntil: 'load' });
await teacher.waitForTimeout(1500);

// 教师端先截图基线（这一版数量固定 3 个，移动不改变文案，只能比画面）
const cardStage = teacher.locator('.group-card[data-group="3"] .card-stage');
const cardBefore = await cardStage.screenshot();

// 学生移动一块（拖动）——先开启「移动木块」，否则闸门会让点击无效
await student.click('.tool-mode-btn:visible');
await student.waitForTimeout(250);
const sceneBox = await student.locator('#scene').boundingBox();
const cubes0 = groups[2].tasks[groups[2].task];
const pFrom = screenOf(sceneBox, cubes0[0], cubes0);
const pTo = screenOf(sceneBox, [4, 0, 4], cubes0, { ground: true });
await student.mouse.move(pFrom.x, pFrom.y);
await student.mouse.down();
await student.mouse.move(pTo.x, pTo.y, { steps: 14 });
await student.mouse.up();
await student.waitForTimeout(1000);
const studentCount = (await student.textContent('#cubeCount')).trim();
console.log(`学生端方块数：${studentCount}`);
if (studentCount !== '6 块') errors.push(`[学生端] 任务一初始应为 6 块，实际 ${studentCount}`);

// 教师端没有任何长连接，只能靠轮询：等 6 秒
await teacher.waitForTimeout(6000);
const cardAfter = await cardStage.screenshot();
const before = crypto.createHash('sha1').update(cardBefore).digest('hex').slice(0, 12);
const after = crypto.createHash('sha1').update(cardAfter).digest('hex').slice(0, 12);
console.log(`教师端（轮询）第 3 组卡片：${before} -> ${after}`);
if (before === after) errors.push('[轮询] 学生移动后，教师端没有同步');

// 学生端保存成功后必须能看到「已保存」（轮询状态不能把它覆盖掉）
const sSavedText = (await student.locator('#statusText').textContent()).trim();
console.log(`学生端保存后的状态：${sSavedText}`);
if (!sSavedText.startsWith('已保存')) {
  errors.push(`[状态] 轮询模式把"已保存"覆盖掉了，当前显示「${sSavedText}」`);
}

// 状态栏不能因为 304 被误判成断开
const statusText = (await teacher.locator('#statusText').textContent()).trim();
const statusState = await teacher.getAttribute('#status', 'data-state');
console.log(`教师端状态：${statusText}（${statusState}）`);
if (statusState === 'offline') errors.push('[轮询] 304 被误判成"连接断开"');

// 学生端这边也一样
const sStatus = await student.getAttribute('#status', 'data-state');
const sText = (await student.locator('#statusText').textContent()).trim();
console.log(`学生端状态：${sText}（${sStatus}）`);
if (sStatus === 'offline') errors.push('[轮询] 学生端把 304 当成了离线');

console.log(`\n请求统计：/api/state 200 共 ${stats.state200} 次，304 共 ${stats.state304} 次，/api/events 204 共 ${stats.events204} 次`);
if (stats.state304 === 0) errors.push('[304] 前端没有带 If-None-Match，一次 304 都没命中（省流量设计没生效）');
if (stats.state200 < 1) errors.push('[304] 一次完整响应都没有');

// ---------------------------------------------------------------- 场景二：SSE 握手成功但永不推数据
// 这模拟"有个代理接住了长连接、却把数据缓冲住"的情况。
// 前端必须在 3 秒内识破并切到轮询，否则页面会静默停在旧画面上。
console.log('\n场景二：SSE 连上了但不推数据（应当自动降级为轮询）');

let hangRequests = { state: 0, events: 0 };
const hangGroups = Array.from({ length: 8 }, (_, i) => mkGroup(i));
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, If-None-Match',
  'Access-Control-Expose-Headers': 'ETag',
};
const hangServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, BASE);
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    return res.end();
  }
  if (url.pathname === '/api/events') {
    hangRequests.events += 1;
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', ...CORS });
    res.write('retry: 2000\n\n');       // 建立了流，但永远不写 state
    return undefined;                    // 故意不 end
  }
  if (url.pathname === '/api/state') {
    hangRequests.state += 1;
    const body = JSON.stringify({ serverTime: Date.now(), limits: { sizeX: 5, sizeY: 5, sizeZ: 5 }, groupCount: 8, groups: hangGroups });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store', ...CORS });
    return res.end(body);
  }
  const post = url.pathname.match(/^\/api\/groups\/(\d+)$/);
  if (post && req.method === 'POST') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    const hgId = Number(post[1]);
    const ht = Number(body.task) || 1;
    const hprev = hangGroups[hgId - 1] ?? mkGroup(hgId - 1);
    const htasks = { 1: hprev.tasks[1], 2: hprev.tasks[2], 3: hprev.tasks[3] };
    htasks[ht] = body.cubes ?? [];
    hangGroups[hgId - 1] = { group: hgId, task: ht, tasks: htasks, updatedAt: Date.now() };
    res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
    return res.end('{}');
  }
  let rel = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = path.join(PUBLIC, path.normalize(rel));
  try {
    const stat = await fsp.stat(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Content-Length': stat.size });
    return fs.createReadStream(file).pipe(res);
  } catch {
    res.writeHead(404);
    return res.end('not found');
  }
});
await new Promise((r) => hangServer.listen(PORT + 1, '127.0.0.1', r));

const browser2 = await chromium.launch({ headless: true, executablePath });
const ctx2 = await browser2.newContext({ viewport: { width: 1280, height: 800 }, locale: 'zh-CN' });
const page2 = hook(await ctx2.newPage());
await page2.goto(`http://127.0.0.1:${PORT + 1}/?reset`, { waitUntil: 'load' });
await page2.locator('#groupGrid button:has-text("第 5 组")').click();
await page2.waitForTimeout(6500);   // 3 秒超时 + 至少一轮轮询

const sseStatus = await page2.getAttribute('#status', 'data-state');
console.log(`  6.5 秒后：/api/events ${hangRequests.events} 次，/api/state ${hangRequests.state} 次，状态 ${sseStatus}`);
if (hangRequests.state < 2) {
  errors.push('[降级] SSE 连上了但不推数据时，前端没有自动切换到轮询（状态会永远停在旧画面）');
}

// ---------------------------------------------------------------- 场景三：前后端分离时，关页面那一刻的保存
// 页面由 5199 提供，?api= 指向 5198 的后端。学生放完方块立刻关页面，
// 这次保存必须打到 5198，而不是页面的源。
console.log('\n场景三：前后端分离 + 关页面时的最后一次保存');
const ctx3 = await browser2.newContext({ viewport: { width: 1280, height: 800 }, locale: 'zh-CN' });
const page3 = hook(await ctx3.newPage());
await page3.goto(`http://127.0.0.1:${PORT}/?reset&api=http://127.0.0.1:${PORT + 1}`, { waitUntil: 'load' });
await page3.locator('#groupGrid button:has-text("第 6 组")').click();
await page3.waitForTimeout(900);
// 移动一块（点选 + 点目标格），然后立刻关页面
const box3 = await page3.locator('#scene').boundingBox();
const cubes3 = hangGroups[5].tasks[hangGroups[5].task];
const from3 = screenOf(box3, cubes3[0], cubes3);
const to3 = screenOf(box3, [0, 0, 4], cubes3, { ground: true });
// 先开启「移动木块」，否则闸门会拦住这次拖动
await page3.click('.tool-mode-btn:visible');
await page3.waitForTimeout(250);
await page3.mouse.move(from3.x, from3.y);
await page3.mouse.down();
await page3.mouse.move(to3.x, to3.y, { steps: 14 });
await page3.mouse.up();
// 保存防抖是 350ms，立刻触发 pagehide，验证这次保存打到了正确的后端
await page3.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
await page3.waitForTimeout(1500);

const savedAtBackend = hangGroups[5].tasks[hangGroups[5].task];
const movedToTarget = savedAtBackend.some((c) => c[0] === 0 && c[1] === 0 && c[2] === 4);
console.log(`  后端（5198）第 6 组：${JSON.stringify(savedAtBackend)}（页面由 5199 提供）`);
if (savedAtBackend.length !== 6 || !movedToTarget) {
  errors.push(`[分离部署] 关页面时的保存打到了错误的地址或没生效（${JSON.stringify(savedAtBackend)}）`);
}
await ctx3.close();

await browser2.close();
hangServer.close();

await browser.close();
server.close();

console.log('\n结果：');
if (errors.length) {
  for (const e of errors) console.log(`  ✗ ${e}`);
  process.exitCode = 1;
} else {
  console.log('  ✓ 无服务器模式下：轮询同步、304 命中、状态显示都正常');
}
