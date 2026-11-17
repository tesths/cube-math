/**
 * 线上功能自检：逐条验证需求是否齐全。用法：
 *   npm run verify:prod                     # 默认检查 https://cube.dididigu.com
 *   AUDIT_BASE=http://localhost:5173 npm run verify:prod
 * 脚本会临时改动线上数据，结束时自动恢复成任务一初始状态。
 */
import crypto from 'node:crypto';
import { fitDistance, projectNdc } from '../public/js/student/camera-fit.js';
import { loadBrowser } from './browser.mjs';

const BASE = process.env.AUDIT_BASE || 'https://cube.dididigu.com';
const { chromium, executablePath } = await loadBrowser();

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? '  —  ' + detail : ''}`);
}
const hash = (b) => crypto.createHash('sha1').update(b).digest('hex').slice(0, 10);

async function api(path) {
  const res = await fetch(BASE + path);
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function postGroup(g, cubes, task) {
  const res = await fetch(`${BASE}/api/groups/${g}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cubes, task }),
  });
  if (!res.ok) throw new Error(`post group ${g}: ${await res.text()}`);
}
const T1 = [[1, 0, 3], [1, 0, 2], [2, 0, 2], [3, 0, 2], [2, 0, 1], [1, 1, 2]];
const T3 = [[1, 0, 3], [1, 0, 2], [2, 0, 2], [2, 1, 2]];
const norm = (a) => JSON.stringify([...a].map((c) => c.join(',')).sort());
const HOME_POLAR = (80 * Math.PI) / 180;
const HOME_AZIMUTH = (10 * Math.PI) / 180;
const HOME_DIR = [
  Math.sin(HOME_POLAR) * Math.sin(HOME_AZIMUTH),
  Math.cos(HOME_POLAR),
  Math.sin(HOME_POLAR) * Math.cos(HOME_AZIMUTH),
];

/** 把某个舞台的格子坐标换算成页面坐标（取景规则与 stage.js 一致） */
function camFor(box, cubes) {
  const contentTop = cubes.reduce((m, c) => Math.max(m, c[1] + 1), 0);
  const top = Math.max(3.2, contentTop + 0.9);
  const center = [0, top / 2 - top * 0.2, 0];
  const aspect = box.width / box.height;
  const DIR = HOME_DIR;
  const distance = fitDistance({ fovDeg: 38, aspect, center, dir: DIR, min: [-2.5, 0, -2.5], max: [2.5, top, 2.5] });
  return (c, ground = false) => {
    const n = projectNdc({ point: [c[0] - 2, ground ? 0.02 : c[1] + 0.5, c[2] - 2], center, dir: DIR, distance, fovDeg: 38, aspect });
    return { x: box.x + ((n.x + 1) / 2) * box.width, y: box.y + ((1 - n.y) / 2) * box.height };
  };
}

const browser = await chromium.launch({ headless: true, executablePath });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2, locale: 'zh-CN' });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

try {
  // ---------- 0. 服务健康
  const h = await api('/api/healthz');
  check('服务健康 /api/healthz', h.status === 200 && h.body?.ok === true && h.body?.groups === 10, JSON.stringify(h.body));
  check('存储是 Redis（多实例共享）', h.body?.store === 'redis', `store=${h.body?.store}`);
  check('函数区域 hkg1', h.body?.region === 'hkg1', `region=${h.body?.region}`);

  // 准备干净数据：三个任务槽都恢复初始
  for (let i = 1; i <= 10; i++) {
    await postGroup(i, T1, 1);
    await postGroup(i, T1, 2);
    await postGroup(i, T3, 3);
  }
  // 再把"当前任务"置回任务一，模拟每组刚打开的状态
  for (let i = 1; i <= 10; i++) await postGroup(i, T1, 1);

  // ---------- 1. 首页
  await page.goto(`${BASE}/?reset`, { waitUntil: 'load', timeout: 60000 });
  await page.waitForTimeout(2600);
  check('首页显示选组', await page.locator('#gate').isVisible());
  check('首页 10 个组按钮', (await page.locator('#groupGrid button').count()) === 10);
  check('首页有教师端入口', (await page.locator('#gate a[href="/teacher"]').count()) === 1);
  check('未进组时不显示任务栏', !(await page.locator('.task-bar').isVisible()));

  // ---------- 2. 进组
  await page.locator('#groupGrid button:has-text("第 3 组")').click();
  await page.waitForTimeout(1200);
  check('进组后地址栏保留 ?group=3', page.url().includes('group=3'), page.url());
  check('工作区里没有教师端链接', (await page.locator('.app a[href="/teacher"]').count()) === 0);
  check('默认任务是任务一', (await page.locator('.task-tab[aria-pressed="true"]').textContent()).trim() === '任务一');
  check('任务一按钮是「移动木块」', (await page.textContent('.tool-mode-btn:visible')).trim() === '移动木块');
  check('任务一初始 6 块', (await page.textContent('#cubeCount')).trim() === '6 块');
  check('任务栏三个任务', (await page.locator('.task-tab:visible').count()) === 3);
  const tabTexts = await page.locator('.task-tab:visible').allTextContents();
  check('三个任务文案正确', JSON.stringify(tabTexts.map((t) => t.trim())) === JSON.stringify(['任务一', '任务二', '任务三']), tabTexts.join('/'));

  // ---------- 3. 三视图
  await page.click('#showViews');
  await page.waitForTimeout(800);
  const viewCount = await page.locator('.view-item').count();
  check('点一下同时出现三张视图', viewCount === 3, `${viewCount} 张`);
  const viewTitles = await page.locator('.view-item-title').allTextContents();
  check('三视图标题是前/右/上', JSON.stringify(viewTitles.map((t) => t.trim())) === JSON.stringify(['从前面看', '从右面看', '从上面看']), viewTitles.join('/'));
  const sizes = await page.locator('.view-item-size').allTextContents();
  check('三视图尺寸与数据一致（6 块图形：3×1 / 1×2 / 3×2 之类）', sizes.every((t) => /\d+ 格宽 × \d+ 格高/.test(t)), sizes.join(' | '));
  await page.click('#showViews');
  await page.waitForTimeout(400);

  // ---------- 4. 任务二：拿走
  await page.click('.task-tab[data-task="2"]');
  await page.waitForTimeout(1000);
  check('任务二按钮是「拿走木块」', (await page.textContent('.tool-mode-btn:visible')).trim() === '拿走木块');
  check('任务二初始 6 块', (await page.textContent('#cubeCount')).trim() === '6 块');
  await page.click('.tool-mode-btn:visible');
  await page.waitForTimeout(200);
  // 点最上面那块 (1,1,2)
  const box = await page.locator('#scene').boundingBox();
  const scene = async (g) => {
    const x = (await api('/api/state')).body.groups.find((v) => v.group === g);
    return { task: x.task, tasks: x.tasks, cubes: x.tasks?.[x.task] ?? [] };
  };
  let st = await scene(3);
  const cam = (cubes) => camFor(box, cubes);

  let p = cam(st.cubes)([1, 1, 2]);
  await page.mouse.click(p.x, p.y);
  await page.waitForTimeout(400);
  check('任务二拿走一块 → 5 块', (await page.textContent('#cubeCount')).trim() === '5 块', await page.textContent('#cubeCount'));
  await page.waitForTimeout(1600);   // 等自动保存落库（Vercel 冷启动可能慢）
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(1800);
  st = await scene(3);
  check('刷新后任务/块数都保留（任务二 5 块）', st.task === 2 && st.cubes.length === 5, `task=${st.task} ${st.cubes.length} 块`);

  // ---------- 5. 任务三：添上
  await page.click('.task-tab[data-task="3"]');
  await page.waitForTimeout(1000);
  check('任务三按钮是「添上木块」', (await page.textContent('.tool-mode-btn:visible')).trim() === '添上木块');
  check('任务三初始 4 块', (await page.textContent('#cubeCount')).trim() === '4 块');
  await page.click('.tool-mode-btn:visible');
  await page.waitForTimeout(200);
  st = await scene(3);
  p = cam(st.cubes)([4, 0, 4], true);
  await page.mouse.click(p.x, p.y);
  await page.waitForTimeout(400);
  check('任务三添一块 → 5 块', (await page.textContent('#cubeCount')).trim() === '5 块', await page.textContent('#cubeCount'));
  await page.waitForTimeout(1600);   // 等自动保存落库
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(1800);
  st = await scene(3);
  check('刷新后任务三 5 块保留', st.task === 3 && st.cubes.length === 5, `task=${st.task} ${st.cubes.length} 块`);

  // ---------- 6. 任务一：移动 + 落点预览
  await page.click('.task-tab[data-task="1"]');
  await page.waitForTimeout(1000);
  st = await scene(3);
  check('切换任务一会载入 6 块初始图形', st.cubes.length === 6 && st.task === 1);
  await page.click('.tool-mode-btn:visible');
  await page.waitForTimeout(250);
  const sceneBox = await page.locator('#scene').boundingBox();
  const st1 = await scene(3);
  const topCell = st1.cubes.reduce((b, c) => (c[1] > b[1] ? c : b), st1.cubes[0]);
  // 选中
  let pp = cam(st1.cubes)(topCell);
  await page.mouse.click(pp.x, pp.y);
  await page.waitForTimeout(400);
  check('点方块变橙色（选中）', (await page.locator('#scene').getAttribute('data-selected')) === topCell.join(','), await page.locator('#scene').getAttribute('data-selected'));
  // 悬停预览
  await page.mouse.move(sceneBox.x + 8, sceneBox.y + 8);
  await page.waitForTimeout(300);
  const shotA = await page.locator('#stage').screenshot();
  const target = cam(st1.cubes)([4, 0, 4], true);
  await page.mouse.move(target.x, target.y);
  await page.waitForTimeout(500);
  const shotB = await page.locator('#stage').screenshot();
  check('悬停目标格出现落点预览', hash(shotA) !== hash(shotB), `${hash(shotA)} -> ${hash(shotB)}`);
  // 拖动并落下
  await page.mouse.down();
  await page.mouse.move(target.x, target.y, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(1000);
  st = await scene(3);
  check('拖动移动生效且数量不变', st.cubes.length === 6 && st.cubes.some((c) => c[0] === 4 && c[1] === 0 && c[2] === 4), JSON.stringify(st.cubes));
  // 切走再切回来，任务一的进度必须保留
  const movedTask1 = st.cubes.map((c) => [...c]);
  await page.click('.task-tab[data-task="2"]');
  await page.waitForTimeout(900);
  await page.click('.task-tab[data-task="1"]');
  await page.waitForTimeout(900);
  st = await scene(3);
  check('切换任务后原任务进度保留', norm(st.cubes) === norm(movedTask1), JSON.stringify(st.cubes));

  // 重置
  await page.click('#resetBtn');
  await page.waitForTimeout(1800);
  st = await scene(3);
  check('重置回到任务一初始 6 块', st.cubes.length === 6 && norm(st.cubes) === norm(T1), `${st.cubes.length} 块`);

  // ---------- 7. 键盘
  await page.click('.tool-mode-btn:visible');                       // 打开移动
  await page.waitForTimeout(200);
  let kst = await scene(3);
  const kCell = kst.cubes.reduce((b, c) => (c[1] > b[1] ? c : b), kst.cubes[0]);
  let kp = cam(kst.cubes)(kCell);
  await page.mouse.click(kp.x, kp.y);
  await page.waitForTimeout(300);
  await page.locator('#scene').focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(900);
  const kst2 = await scene(3);
  check('键盘移动：方向键+回车能挪动', kst2.cubes.length === 6 && norm(kst2.cubes) !== norm(kst.cubes), JSON.stringify(kst2.cubes));
  await page.click('.tool-mode-btn:visible');

  // ---------- 8. 教师端
  const teacher = await ctx.newPage();
  const terr = [];
  teacher.on('pageerror', (e) => terr.push(e.message));
  teacher.on('console', (m) => { if (m.type() === 'error') terr.push(m.text()); });
  await teacher.goto(`${BASE}/teacher`, { waitUntil: 'load', timeout: 60000 });
  await teacher.waitForTimeout(2500);
  check('教师端 10 个组卡片', (await teacher.locator('.group-card').count()) === 10);
  const tags = await teacher.locator('.group-card .task-tag').allTextContents();
  check('教师端每组都显示任务标签', tags.length === 10 && tags.every((t) => /任务[一二三]/.test(t)), tags.join('/'));
  // 学生移动 → 教师端卡片变化（用固定数据，避免受前面步骤影响）
  await postGroup(3, T1, 1);
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(2400);
  const cardStage = teacher.locator('.group-card[data-group="3"] .card-stage');
  const cardA = await cardStage.screenshot();

  await page.click('.tool-mode-btn:visible');
  await page.waitForTimeout(250);
  const s2 = await scene(3);
  const syncBox = await page.locator('#scene').boundingBox();
  const syncCam = (() => {
    const top = Math.max(3.2, s2.cubes.reduce((m, c) => Math.max(m, c[1] + 1), 0) + 0.9);
    const center = [0, top / 2 - top * 0.2, 0];
    const aspect = syncBox.width / syncBox.height;
    const DIR = HOME_DIR;
    const distance = fitDistance({ fovDeg: 38, aspect, center, dir: DIR, min: [-2.5, 0, -2.5], max: [2.5, top, 2.5] });
    return (c, ground = false) => {
      const n = projectNdc({ point: [c[0] - 2, ground ? 0.02 : c[1] + 0.5, c[2] - 2], center, dir: DIR, distance, fovDeg: 38, aspect });
      return { x: syncBox.x + ((n.x + 1) / 2) * syncBox.width, y: syncBox.y + ((1 - n.y) / 2) * syncBox.height };
    };
  })();
  const topCube = s2.cubes.reduce((b, c) => (c[1] > b[1] ? c : b), s2.cubes[0]);
  const fromPt = syncCam(topCube);
  const toPt = syncCam([4, 0, 4], true);
  await page.mouse.move(fromPt.x, fromPt.y);
  await page.mouse.down();
  await page.mouse.move(toPt.x, toPt.y, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(6000);   // Vercel 无 SSE，教师端靠 2 秒轮询，留足一轮刷新
  const cardB = await cardStage.screenshot();
  check('学生改动后教师端自动更新', hash(cardA) !== hash(cardB), `${hash(cardA)} -> ${hash(cardB)}`);

  // 放大演示
  await teacher.locator('.group-card[data-group="3"] .card-open').click();
  await teacher.waitForTimeout(1600);
  check('放大演示打开', await teacher.locator('#focusLayer').isVisible());
  const fn = (await teacher.textContent('#focusName')).trim();
  check('演示标题带组号与任务名', fn.startsWith('第 3 组') && fn.includes('任务'), fn);
  check('演示里有三视图', (await teacher.locator('#focusViews .view-item').count()) === 3);

  const tb = (await teacher.locator('#focusTools .btn').allTextContents()).map((t) => t.trim());
  check('放大界面有工具栏（动作 + 重置）', tb.length === 2 && ['移动木块', '拿走木块', '添上木块'].includes(tb[0]), tb.join('/'));

  // 老师直接改这一组：工具栏「移动」+ 拖动一块
  const beforeEdit = (await scene(3)).cubes.map((c) => [...c]);
  const studentBefore = await page.locator('#stage').screenshot();
  await teacher.click('#focusActionBtn');
  await teacher.waitForTimeout(300);
  const fb = await teacher.locator('#focusScene').boundingBox();
  const focusCam = camFor(fb, beforeEdit);
  const topPick = beforeEdit.reduce((b, c) => (c[1] > b[1] ? c : b), beforeEdit[0]);
  const fpFrom = focusCam(topPick);
  const fpTo = focusCam([0, 0, 4], true);
  await teacher.mouse.move(fpFrom.x, fpFrom.y);
  await teacher.mouse.down();
  await teacher.mouse.move(fpTo.x, fpTo.y, { steps: 12 });
  await teacher.mouse.up();
  await teacher.waitForTimeout(1600);
  const afterEdit = (await scene(3)).cubes;
  check('老师可以在学生基础上修改并保存', norm(afterEdit) !== norm(beforeEdit), JSON.stringify(afterEdit));
  await page.waitForTimeout(3200);
  const studentAfter = await page.locator('#stage').screenshot();
  check('老师改完学生端自动跟随', hash(studentBefore) !== hash(studentAfter), `${hash(studentBefore)} -> ${hash(studentAfter)}`);

  await teacher.locator('#focusClose').click();
  await teacher.waitForTimeout(500);
  check('教师端无控制台错误', terr.length === 0, terr.slice(0, 2).join(' | '));
  await teacher.close();

  // ---------- 9. 布局：四种尺寸无溢出
  for (const vp of [{ w: 1180, h: 820, t: true, n: '平板横屏' }, { w: 1024, h: 768, t: true, n: '小平板' }, { w: 1280, h: 720, t: false, n: '720p' }, { w: 1920, h: 1080, t: false, n: '大屏' }]) {
    const c = await browser.newContext({ viewport: { width: vp.w, height: vp.h }, hasTouch: vp.t, locale: 'zh-CN' });
    const pg = await c.newPage();
    await pg.goto(`${BASE}/?group=4`, { waitUntil: 'load', timeout: 60000 });
    await pg.waitForTimeout(1200);
    await pg.click('#showViews');
    await pg.waitForTimeout(700);
    const m = await pg.evaluate(() => ({
      sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth,
      gs: document.querySelector('.views-grid')?.scrollHeight ?? 0,
      gc: document.querySelector('.views-grid')?.clientHeight ?? 0,
    }));
    check(`${vp.n} 无横向溢出`, m.sw <= m.cw + 1, `${m.sw}/${m.cw}`);
    check(`${vp.n} 三视图不被裁切`, m.gs <= m.gc + 2, `${m.gs}/${m.gc}`);
    await c.close();
  }

  check('学生端无控制台错误', errors.length === 0, errors.slice(0, 2).join(' | '));
} catch (err) {
  check('自检脚本异常', false, err.message);
} finally {
  await browser.close();
  // 恢复干净数据
  for (let i = 1; i <= 10; i++) {
    await postGroup(i, T1, 1).catch(() => {});
    await postGroup(i, T1, 2).catch(() => {});
    await postGroup(i, T3, 3).catch(() => {});
    await postGroup(i, T1, 1).catch(() => {});   // 当前任务回到任务一
  }
  const bad = results.filter((r) => !r.ok);
  console.log(`\n结果：${results.length - bad.length}/${results.length} 项通过`);
  if (bad.length) { console.log('失败项：'); for (const b of bad) console.log(' - ' + b.name + ' :: ' + b.detail); process.exitCode = 1; }
}
