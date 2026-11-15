/**
 * 部署相关测试：
 *   - 文件存储的落盘 / 恢复
 *   - 无服务器（Vercel）分支用内存存储时，API 逻辑与本地服务器一致
 *   - 部署配置文件存在且是合法 JSON
 *
 * 运行：node test/deploy.test.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}\n    ${err.message}`);
    process.exitCode = 1;
  }
}

console.log('部署与存储测试');

// ---------------------------------------------------------------- 文件存储

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cube-views-test-'));

await check('文件存储：写入后落盘，重启能读回来', async () => {
  const { FileStore } = await import('../lib/store.js');
  const store = new FileStore(tmpDir);
  await store.init();
  await store.setGroup(3, [[0, 0, 0], [1, 0, 0]]);
  await store.flush();

  const again = new FileStore(tmpDir);
  await again.init();
  const groups = await again.getAll();
  assert.equal(groups.length, 8, '永远返回 8 个组');
  assert.deepEqual(groups[2].tasks[1], [[0, 0, 0], [1, 0, 0]]);
  assert.ok(groups[2].updatedAt > 0);
});

await check('文件存储：坏数据不会拖垮启动', async () => {
  const dir = path.join(tmpDir, 'broken');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'state.json'), '{ 这不是 JSON');
  const { FileStore } = await import('../lib/store.js');
  const store = new FileStore(dir);
  await store.init();
  const groups = await store.getAll();
  assert.equal(groups.length, 8);
  // 坏数据时按"默认 3 个方块"启动（这一版没有空组）
  assert.ok(groups.every((g) => g.tasks[1].length === 6));   // 任务一的初始摆放是 6 块
});

// ---------------------------------------------------------------- 无服务器分支

process.env.VERCEL = '1';
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;

const { applyGroup, snapshot } = await import('../lib/api-shared.js');

await check('无服务器分支：没有 Redis 时退化为内存存储且可用', async () => {
  const res = await applyGroup(1, { cubes: [[0, 0, 0], [0, 1, 0]] });
  assert.equal(res.ok, true);
  const state = await snapshot();
  assert.equal(state.groups.length, 8);
  assert.equal(state.groups[0].tasks[1].length, 2);
  assert.equal(state.groupCount, 8);
});

await check('无服务器分支：缺 cubes 字段返回 400（不能当成清空）', async () => {
  const res = await applyGroup(1, {});
  assert.equal(res.ok, false);
  assert.equal(res.status, 400);
});

await check('无服务器分支：越界坐标返回 400', async () => {
  const res = await applyGroup(1, { cubes: [[5, 0, 0]] });
  assert.equal(res.ok, false);
  assert.equal(res.status, 400);
});

await check('无服务器分支：不存在的组返回 404', async () => {
  const res = await applyGroup(9, { cubes: [] });
  assert.equal(res.ok, false);
  assert.equal(res.status, 404);
});

await check('无服务器分支：clear 等价于提交空数组', async () => {
  const res = await applyGroup(1, {}, { clear: true });
  assert.equal(res.ok, true);
  const state = await snapshot();
  assert.equal(state.groups[0].tasks[1].length, 0);
  assert.equal(state.groups[0].task, 1);
});

await check('无服务器分支：悬空方块被服务器拒绝', async () => {
  const res = await applyGroup(2, { cubes: [[0, 3, 0]] });
  assert.equal(res.ok, false);
  assert.equal(res.status, 400);
});

// ---------------------------------------------------------------- 部署配置

await check('vercel.json 是合法 JSON 且有静态输出目录', async () => {
  const raw = await fs.readFile(path.join(root, 'vercel.json'), 'utf8');
  const cfg = JSON.parse(raw);
  assert.equal(cfg.outputDirectory, 'public');
  assert.ok(Array.isArray(cfg.rewrites));
});

await check('railway.json 是合法 JSON 且指向 Dockerfile', async () => {
  const raw = await fs.readFile(path.join(root, 'railway.json'), 'utf8');
  const cfg = JSON.parse(raw);
  assert.equal(cfg.build.builder, 'DOCKERFILE');
  assert.equal(cfg.deploy.healthcheckPath, '/healthz');
});

await check('Dockerfile 使用环境变量端口并暴露健康检查', async () => {
  const raw = await fs.readFile(path.join(root, 'Dockerfile'), 'utf8');
  assert.match(raw, /ENV [\s\S]*PORT=8080/);
  assert.match(raw, /HEALTHCHECK/);
  assert.match(raw, /CMD \["node", "server\.js"\]/);
});

await check('Vercel API 函数文件齐全', async () => {
  for (const file of ['api/state.js', 'api/events.js', 'api/groups/[group].js', 'api/groups/[group]/clear.js']) {
    await fs.access(path.join(root, file));
  }
});

await check('前端有运行时配置文件（前后端分开部署时用）', async () => {
  const raw = await fs.readFile(path.join(root, 'public/config.js'), 'utf8');
  assert.match(raw, /CUBE_VIEWS_CONFIG/);
  assert.match(raw, /apiBase/);
});

await fs.rm(tmpDir, { recursive: true, force: true });
console.log(`\n${passed} 项通过${process.exitCode ? '，有失败项' : ''}`);
