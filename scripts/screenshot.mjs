/**
 * 浏览器端到端验证：截图 + 真交互断言（不是人工点检）。
 * 运行：node scripts/screenshot.mjs
 * 跑完会把 8 个组恢复成任务一的初始摆放（每个组 6 块）。
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { computeViews } from '../public/js/shared/model.js';
import { fitDistance, projectNdc } from '../public/js/student/camera-fit.js';

import { loadBrowser } from './browser.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'shots');
await fs.mkdir(outDir, { recursive: true });

const BASE = process.env.BASE || 'http://localhost:5173';
const errors = [];

const { chromium, executablePath } = await loadBrowser();
console.log(`浏览器：${executablePath}\n`);

const FOV = 38;
// 与 shared/view.js 的 HOME_ANGLES 一致：俯仰 80°、方位 10°
const HOME_POLAR = (80 * Math.PI) / 180;
const HOME_AZIMUTH = (10 * Math.PI) / 180;
const DIR = [
  Math.sin(HOME_POLAR) * Math.sin(HOME_AZIMUTH),
  Math.cos(HOME_POLAR),
  Math.sin(HOME_POLAR) * Math.cos(HOME_AZIMUTH),
];

/** 与 stage.js 完全一致的取景参数：按内容高度、并整体上移 20% */
function cameraFor(cubes) {
  const contentTop = (cubes ?? []).reduce((m, c) => Math.max(m, c[1] + 1), 0);
  const top = Math.max(3.2, contentTop + 0.9);
  return { top, center: [0, top / 2 - top * 0.2, 0] };
}

/** 把格子坐标换算成页面坐标（用于真的去点某个方块） */
function screenOfCell(rect, [x, y, z], cubes, { ground = false } = {}) {
  const aspect = rect.width / rect.height;
  const { top, center } = cameraFor(cubes);
  const distance = fitDistance({
    fovDeg: FOV, aspect, center, dir: DIR, min: [-2.5, 0, -2.5], max: [2.5, top, 2.5],
  });
  const ndc = projectNdc({
    // 点方块用方块中心（y+0.5）；点空地格用地面（y=0），否则反投影会落到别的格子
    point: [x - 2, ground ? 0.02 : y + 0.5, z - 2], center, dir: DIR, distance, fovDeg: FOV, aspect,
  });
  return {
    x: rect.x + ((ndc.x + 1) / 2) * rect.width,
    y: rect.y + ((1 - ndc.y) / 2) * rect.height,
  };
}

async function post(group, cubes, task = 1) {
  const res = await fetch(`${BASE}/api/groups/${group}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cubes, task }),
  });
  if (!res.ok) throw new Error(`写入第 ${group} 组失败：${await res.text()}`);
}

async function stateOf(group, task) {
  const res = await fetch(`${BASE}/api/state`);
  const g = (await res.json()).groups.find((x) => x.group === group);
  const t = task ?? g.task;
  return (g.tasks?.[t] ?? []).map((c) => [...c]);
}

async function taskOf(group) {
  const res = await fetch(`${BASE}/api/state`);
  return (await res.json()).groups.find((x) => x.group === group).task;
}

const hash = (buf) => crypto.createHash('sha1').update(buf).digest('hex').slice(0, 12);

// 任务一初始（6 块）与任务三初始（4 块，含正中间上方那块），给不同组摆不同任务，方便看教师端差异
const T1 = [[1, 0, 3], [1, 0, 2], [2, 0, 2], [3, 0, 2], [2, 0, 1], [1, 1, 2]];
const T3 = [[1, 0, 3], [1, 0, 2], [2, 0, 2], [2, 1, 2]];
const SEED = [
  [1, T1, 1], [2, T1, 1], [3, T1, 1], [4, T1, 2],
  [5, T3, 3], [6, T1, 1], [7, T1, 2], [8, T3, 3],
];
for (const [group, cubes, task] of SEED) {
  // 三个任务槽都重置，避免上一轮跑测试留下的进度影响这一轮
  await post(group, T1, 1);
  await post(group, T1, 2);
  await post(group, T3, 3);
  await post(group, cubes, task);
}
console.log('已写入示例数据（跑完会清空）\n');

const browser = await chromium.launch({ headless: true, executablePath });

function hook(page) {
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`[console] ${msg.text()}`);
  });
  page.on('pageerror', (err) => errors.push(`[pageerror] ${err.message}`));
  return page;
}

async function shot(page, name) {
  const file = path.join(outDir, `${name}.png`);
  await page.screenshot({ path: file });
  console.log(`  · ${path.relative(root, file)}`);
}

async function noHorizontalScroll(page, label) {
  const over = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  if (over.scrollWidth > over.innerWidth + 2) {
    errors.push(`[适配] ${label} 出现横向溢出 ${over.scrollWidth} > ${over.innerWidth}`);
  }
  return over;
}

// ---------------------------------------------------------------- 桌面：学生端

const desktop = await browser.newContext({
  viewport: { width: 1600, height: 1000 },
  deviceScaleFactor: 2,
  locale: 'zh-CN',
});
const newPage = async (ctx = desktop) => hook(await ctx.newPage());
const student = await newPage();
await student.goto(`${BASE}/?group=3`, { waitUntil: 'load' });
await student.waitForTimeout(1200);
await shot(student, 'student-desktop');

// —— 三个任务：顶栏标签、按钮文案、图形、三种操作
console.log('任务切换与三种操作');
const taskInfo = async () => ({
  tabs: await student.locator('.task-tab:visible').evaluateAll((bs) => bs.map((b) => `${b.textContent}${b.getAttribute('aria-pressed') === 'true' ? '*' : ''}`)),
  btn: (await student.textContent('.tool-mode-btn:visible')).trim(),
  count: (await student.textContent('#cubeCount')).trim(),
});

let ti = await taskInfo();
console.log(`  初始：${ti.tabs.join(' ')} · 按钮=${ti.btn} · ${ti.count}`);
if (ti.btn !== '移动木块' || ti.count !== '6 块') errors.push(`[任务] 任务一应为"移动木块/6 块"，实际 ${JSON.stringify(ti)}`);

await student.click('.task-tab[data-task="2"]');
await student.waitForTimeout(900);
ti = await taskInfo();
console.log(`  任务二：${ti.tabs.join(' ')} · 按钮=${ti.btn} · ${ti.count}`);
if (ti.btn !== '拿走木块' || ti.count !== '6 块') errors.push(`[任务] 任务二应为"拿走木块/6 块"，实际 ${JSON.stringify(ti)}`);

await student.click('.task-tab[data-task="3"]');
await student.waitForTimeout(900);
ti = await taskInfo();
console.log(`  任务三：${ti.tabs.join(' ')} · 按钮=${ti.btn} · ${ti.count}`);
if (ti.btn !== '添上木块' || ti.count !== '4 块') errors.push(`[任务] 任务三应为"添上木块/4 块"，实际 ${JSON.stringify(ti)}`);

const taskStageBox = await student.locator('#scene').boundingBox();

// 任务三：先点「添上木块」，再在空地上添一块（4 → 5）
let t3cubes = await stateOf(3);
let pAdd = screenOfCell(taskStageBox, [4, 0, 4], t3cubes, { ground: true });
await student.click('.tool-mode-btn:visible');
await student.waitForTimeout(200);
await student.mouse.click(pAdd.x, pAdd.y);
await student.waitForTimeout(900);
const afterAdd = await stateOf(3);
console.log(`  任务三添一块：${afterAdd.length} 块`);
const norm = (a) => JSON.stringify(a.map((c) => c.join(',')).sort());
if (afterAdd.length !== 5 || !afterAdd.some((c) => c[0] === 4 && c[1] === 0 && c[2] === 4)) {
  errors.push(`[任务] 任务三添一块后应变成 5 块并包含 [4,0,4]（实际 ${JSON.stringify(afterAdd)}）`);
}
await student.waitForTimeout(200);

// 任务二：拿走一块（6 → 5）
await student.click('.task-tab[data-task="2"]');
await student.waitForTimeout(900);
const t2cubes = await stateOf(3);
const pErase = screenOfCell(taskStageBox, [1, 1, 2], t2cubes);
await student.click('.tool-mode-btn:visible');
await student.waitForTimeout(200);
await student.mouse.click(pErase.x, pErase.y);
await student.waitForTimeout(900);
const afterErase = await stateOf(3);
console.log(`  任务二拿走一块：${afterErase.length} 块`);
if (afterErase.length !== 5) errors.push(`[任务] 任务二拿走一块后应为 5 块（实际 ${afterErase.length}）`);

// 重置回到任务二初始（6 块）
await student.click('#resetBtn');
await student.waitForTimeout(900);
const afterResetT2 = await stateOf(3);
console.log(`  重置后：${afterResetT2.length} 块`);
if (afterResetT2.length !== 6) errors.push(`[任务] 重置没有回到任务二初始的 6 块（实际 ${afterResetT2.length}）`);

// 回任务一：移动（6 块不变，位置变化）
await student.click('.task-tab[data-task="1"]');
await student.waitForTimeout(900);
const selBox = await student.locator('#scene').boundingBox();
let cubesNow = await stateOf(3);

// 先点亮「移动木块」——没点亮工具之前点方块不会选中（闸门）
await student.click('.tool-mode-btn:visible');
await student.waitForTimeout(200);

// 点中一块 → 变橙（挑最高的那块，保证不会被别的方块挡住）
const pickCell = cubesNow.reduce((best, c) => (c[1] > best[1] ? c : best), cubesNow[0]);
const pick = screenOfCell(selBox, pickCell, cubesNow);
await student.mouse.click(pick.x, pick.y);
await student.waitForTimeout(400);
const selAfter = await student.locator('#scene').getAttribute('data-selected');
console.log(`  点中一块：data-selected=${JSON.stringify(selAfter)}`);
if (selAfter !== pickCell.join(',')) errors.push(`[选中] 点击积木没有选中它（${selAfter}）`);

// 悬停出落点预览 → 点目标格移动（已处于移动模式并选中）
const hoverAt = screenOfCell(selBox, [4, 0, 4], cubesNow, { ground: true });
await student.mouse.move(selBox.x + 8, selBox.y + 8);   // 先移开，拍基线
await student.waitForTimeout(350);
const noHoverShot = await student.locator('#stage').screenshot();
await student.mouse.move(hoverAt.x, hoverAt.y);          // 悬停到目标格 → 应出现空心落点
await student.waitForTimeout(450);
const ghostShot = await student.locator('#stage').screenshot();
if (hash(noHoverShot) === hash(ghostShot)) errors.push('[移动] 悬停目标格没有出现落点预览（虚线空心框）');
await student.mouse.click(hoverAt.x, hoverAt.y);
await student.waitForTimeout(900);
const afterMove = await stateOf(3);
console.log(`  任务一移动：${cubesNow.length} 块 → ${JSON.stringify(afterMove)}`);
if (afterMove.length !== 6) errors.push(`[任务] 任务一移动后数量变了（${afterMove.length}）`);
if (JSON.stringify(afterMove) === JSON.stringify(cubesNow)) errors.push('[任务] 任务一移动没有生效');
if (!ghostShot.length) errors.push('[移动] 没有截到画面');
await shot(student, 'student-after-move');
await student.click('.tool-mode-btn:visible');   // 关掉移动模式，后面的拖动用普通拖拽
await student.waitForTimeout(200);

// 视角球：按住拖动必须改变角度（平板没有右键，全靠它）
console.log('视角球');
const pad = await student.locator('#orbitPad').boundingBox();
const angleOf = () => student.evaluate(() => window.cubeView?.() || null);
const angBefore = await angleOf();
await student.mouse.move(pad.x + pad.width / 2, pad.y + pad.height / 2);
await student.mouse.down();
await student.mouse.move(pad.x + pad.width / 2 + 120, pad.y + pad.height / 2 + 40, { steps: 14 });
await student.mouse.up();
// 等 OrbitControls 的阻尼完全停下来再读数
await student.waitForTimeout(2200);
const angAfter = await angleOf();
const angKey = (a) => a ? `${a['方位角 θ']}|${a['俯仰角 φ']}` : 'none';
console.log(`  视角球拖动前后角度：${angKey(angBefore)} -> ${angKey(angAfter)}`);
if (angKey(angBefore) === angKey(angAfter)) errors.push('[视角球] 拖动没有改变视角');
await shot(student, 'student-orbit-rotated');

// 点一下视角球不应该回正（回正交给「复位视角」按钮，避免误触）
const angBeforeTap = await angleOf();
await student.click('#orbitPad');
await student.waitForTimeout(1400);
const angAfterTap = await angleOf();
console.log(`  点一下视角球角度：${angKey(angBeforeTap)} -> ${angKey(angAfterTap)}（应该不变）`);
if (angKey(angAfterTap) !== angKey(angBeforeTap)) errors.push('[视角球] 点一下竟然改动了视角（应当只有拖动才转）');

// 「复位视角」按钮回正
const angBeforeReset = await angleOf();
await student.click('#resetView');
await student.waitForTimeout(900);
const angAfterReset = await angleOf();
console.log(`  点「复位视角」角度：${angKey(angBeforeReset)} -> ${angKey(angAfterReset)}`);
if (angKey(angAfterReset) !== '10.0°|80.0°') {
  errors.push(`[复位] 复位视角没有回到 10°/80°（实际 ${angKey(angAfterReset)}）`);
}

// 看三视图：一次点开，三个方向同时显示，数字必须等于用服务器真实数据算出的投影
await student.click('#showViews');
await student.waitForTimeout(600);
const cubes = await stateOf(3);
const expected = computeViews(cubes);
for (const id of ['front', 'right', 'top']) {
  const text = (await student.locator(`.view-item[data-view="${id}"] .view-item-size`).textContent()).trim();
  const want = `${expected[id].cols} 格宽 × ${expected[id].rows} 格高`;
  console.log(`  ${id.padEnd(5)} 视图：界面显示 ${text}`);
  if (text !== want) errors.push(`[一致性] ${id} 视图与真实数据不符，应为 ${want}`);
}
const shown = await student.locator('.view-item canvas:visible').count();
console.log(`  同时显示的视图数：${shown}`);
if (shown !== 3) errors.push(`[三视图] 应同时显示 3 个视图，实际 ${shown}`);
await shot(student, 'student-views-all');

await student.click('#showViews');
await student.waitForTimeout(300);
if (!(await student.locator('.views-grid').isHidden())) errors.push('[三视图] 再点一次没有收起');

// ---------------------------------------------------------------- 教师端与实时同步

const teacher = await newPage();
await teacher.goto(`${BASE}/teacher`, { waitUntil: 'load' });
await teacher.waitForTimeout(1500);
await shot(teacher, 'teacher-desktop');

// 方块数量不变，移动不改变文案，所以比较教师端卡片画面
await post(3, [[1, 0, 3], [1, 0, 2], [2, 0, 2], [3, 0, 2], [2, 0, 1], [1, 1, 2]], 1);
await student.reload({ waitUntil: 'load' });
await student.waitForTimeout(1200);
const cardStage = teacher.locator('.group-card[data-group="3"] .card-stage');
const cardBefore = await cardStage.screenshot();
cubesNow = await stateOf(3);
await student.click('.tool-mode-btn:visible');   // 开启「移动木块」才能拖动
await student.waitForTimeout(200);
const syncBox = await student.locator('#scene').boundingBox();
const syncTop = cubesNow.reduce((best, c) => (c[1] > best[1] ? c : best), cubesNow[0]);
const syncFrom = screenOfCell(syncBox, syncTop, cubesNow);
const syncTo = screenOfCell(syncBox, [4, 0, 4], cubesNow, { ground: true });
await student.mouse.move(syncFrom.x, syncFrom.y);
await student.mouse.down();
await student.mouse.move(syncTo.x, syncTo.y, { steps: 14 });
await student.mouse.up();
await student.waitForTimeout(2500);
const cardAfter = await cardStage.screenshot();
console.log(`  教师端第 3 组卡片：${hash(cardBefore)} -> ${hash(cardAfter)}`);
if (hash(cardBefore) === hash(cardAfter)) errors.push('[实时] 学生移动方块后，教师端没有跟着更新');

// 教师端放大演示
console.log('教师端放大演示');
// 明确的「放大」按钮必须存在且可用
const zoomBtn = teacher.locator('.group-card[data-group="3"] .card-open');
if ((await zoomBtn.count()) !== 1) errors.push('[演示] 卡片里没有「放大」按钮');
await zoomBtn.click();
await teacher.waitForTimeout(1200);
const focusOpen = await teacher.locator('#focusLayer').isVisible();
const focusName = (await teacher.locator('#focusName').textContent()).trim();
const focusViews = await teacher.locator('#focusViews .view-item canvas:visible').count();
console.log(`  打开演示：${focusOpen}，${focusName}，三视图数=${focusViews}`);
if (!focusOpen) errors.push('[演示] 点卡片没有打开放大视图');
if (!focusName.startsWith('第 3 组')) errors.push(`[演示] 标题不对：${focusName}`);
if (!focusName.includes('任务')) errors.push(`[演示] 标题里应该带任务名：${focusName}`);
if (focusViews !== 3) errors.push(`[演示] 应显示 3 个视图，实际 ${focusViews}`);

const focusCubes = await stateOf(3);
const focusExpected = computeViews(focusCubes);
for (const id of ['front', 'right', 'top']) {
  const text = (await teacher.locator(`#focusViews .view-item[data-view="${id}"] .view-item-size`).textContent()).trim();
  const want = `${focusExpected[id].cols} 格宽 × ${focusExpected[id].rows} 格高`;
  if (text !== want) errors.push(`[演示] ${id} 视图与实际不符，应为 ${want}`);
}
await shot(teacher, 'teacher-focus');

// 演示里也能用视角球转
const fPad = await teacher.locator('#focusOrbitPad').boundingBox();
const fStage = teacher.locator('#focusStage');
const beforeF = await fStage.screenshot();
await teacher.mouse.move(fPad.x + fPad.width / 2, fPad.y + fPad.height / 2);
await teacher.mouse.down();
await teacher.mouse.move(fPad.x + fPad.width / 2 + 150, fPad.y + 20, { steps: 14 });
await teacher.mouse.up();
await teacher.waitForTimeout(700);
const afterF = await fStage.screenshot();
console.log(`  演示视角球：${hash(beforeF)} -> ${hash(afterF)}`);
if (hash(beforeF) === hash(afterF)) errors.push('[演示] 视角球没有改变视角');
await shot(teacher, 'teacher-focus-rotated');

await teacher.keyboard.press('Escape');
await teacher.waitForTimeout(400);
if (!(await teacher.locator('#focusLayer').isHidden())) errors.push('[演示] Esc 没有退出演示');

await student.close();
await teacher.close();

// ---------------------------------------------------------------- 平板 / 大屏 / 手机

const sizes = [
  { name: 'tablet-landscape', width: 1180, height: 820, touch: true },
  { name: 'tablet-small', width: 1024, height: 768, touch: true },
  { name: 'laptop-720', width: 1280, height: 720, touch: false },
  { name: 'big-screen', width: 1920, height: 1080, touch: false },
];
for (const size of sizes) {
  const ctx = await browser.newContext({
    viewport: { width: size.width, height: size.height },
    deviceScaleFactor: 1,
    hasTouch: size.touch,
    locale: 'zh-CN',
  });
  const page = await newPage(ctx);
  await page.goto(`${BASE}/?group=3`, { waitUntil: 'load' });
  await page.waitForTimeout(1000);
  await page.click('#showViews');
  await page.waitForTimeout(700);
  const overflow = await noHorizontalScroll(page, size.name);
  const layout = await page.evaluate(() => ({
    scrollH: document.documentElement.scrollHeight,
    innerH: window.innerHeight,
    gridClient: document.querySelector('.views-grid').clientHeight,
    gridScroll: document.querySelector('.views-grid').scrollHeight,
  }));
  const padBox = await page.locator('#orbitPad').boundingBox();
  const btnBox = await page.locator('.tool-mode-btn:visible').boundingBox();
  console.log(`  ${size.name} ${size.width}×${size.height}：宽 ${overflow.scrollWidth}/${overflow.innerWidth}，高 ${layout.scrollH}/${layout.innerH}，按钮 ${Math.round(btnBox.height)}px，视角球 ${Math.round(padBox.width)}px，三视图 ${layout.gridClient}/${layout.gridScroll}`);
  // "≥44px" 是对触屏的要求；鼠标布局下 38px 是桌面习惯尺寸
  if (size.touch && btnBox.height < 44) {
    errors.push(`[适配] ${size.name} 按钮高度只有 ${Math.round(btnBox.height)}px，平板不好点`);
  }
  // 视角球刻意缩小了：触屏要够大（≥80），鼠标布局 64 就够
  const minPad = size.touch ? 80 : 64;
  if (padBox.width < minPad) errors.push(`[适配] ${size.name} 视角球只有 ${Math.round(padBox.width)}px`);
  // 页面不应该出现纵向滚动条（大屏/一体机要"一屏到底"）
  if (layout.scrollH > layout.innerH + 1) {
    errors.push(`[适配] ${size.name} 出现纵向溢出 ${layout.scrollH} > ${layout.innerH}`);
  }
  // 三张视图必须整块放得下，不能被裁掉半截
  if (layout.gridScroll > layout.gridClient + 2) {
    errors.push(`[适配] ${size.name} 三视图被裁切：内容 ${layout.gridScroll} > 可视 ${layout.gridClient}`);
  }
  await shot(page, `student-${size.name}`);

  const t = await newPage(ctx);
  await t.goto(`${BASE}/teacher`, { waitUntil: 'load' });
  await t.waitForTimeout(1200);
  await t.locator('.group-card[data-group="6"]').click();
  await t.waitForTimeout(900);
  await shot(t, `teacher-focus-${size.name}`);
  await t.close();
  await page.close();
  await ctx.close();
}

// 手机
const mobile = await browser.newContext({
  viewport: { width: 414, height: 900 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  locale: 'zh-CN',
});
const mStudent = await newPage(mobile);
await mStudent.goto(`${BASE}/?group=5`, { waitUntil: 'load' });
await mStudent.waitForTimeout(1200);
await mStudent.click('#showViews');
await mStudent.waitForTimeout(700);
await noHorizontalScroll(mStudent, 'mobile');
await shot(mStudent, 'student-mobile');
await mStudent.close();
await mobile.close();

// ---------------------------------------------------------------- 首页与锁定

console.log('首页与锁定');
const gate = await newPage();
await gate.goto(`${BASE}/?reset`, { waitUntil: 'load' });
await gate.waitForTimeout(900);
await shot(gate, 'home-desktop');

const gateCount = await gate.locator('#groupGrid button').count();
console.log(`  首页组按钮数：${gateCount}`);
if (gateCount !== 8) errors.push(`[首页] 组按钮数量应为 8，实际 ${gateCount}`);

// 首页上不能有任何"换组"入口
const switchCount = await gate.locator('#switchGroup').count();
if (switchCount !== 0) errors.push('[锁定] 仍然存在换组按钮');

// 首页要有教师端入口，且指向 /teacher
const teacherEntry = gate.locator('#gate a[href="/teacher"]');
if ((await teacherEntry.count()) !== 1) errors.push('[入口] 首页没有教师端入口');
const teacherHref = await teacherEntry.getAttribute('href');
console.log(`  首页教师端入口：${teacherHref}`);
if (teacherHref !== '/teacher') errors.push(`[入口] 教师端入口指向了 ${teacherHref}`);

// 选中第 4 组 → 进工作区，地址栏要带上 ?group=4
await gate.locator('#groupGrid button:has-text("第 4 组")').click();
await gate.waitForTimeout(900);
const labelAfter = (await gate.locator('#groupLabel').textContent()).trim();
const urlAfter = await gate.evaluate(() => location.search);
const workspaceTeacherLinks = await gate.locator('.app a[href="/teacher"]').count();
console.log(`  选第 4 组后：顶栏=${labelAfter}，地址栏=${urlAfter}，工作区里的教师端链接数=${workspaceTeacherLinks}`);
if (workspaceTeacherLinks !== 0) errors.push('[入口] 学生工作区里仍然能点到教师端');
if (labelAfter !== '第 4 组') errors.push(`[首页] 没有进入第 4 组（${labelAfter}）`);
if (!urlAfter.includes('group=4')) errors.push(`[URL] 选完组地址栏里没有 ?group=4（实际 ${urlAfter}）`);

// 刷新后仍然是第 4 组，URL 也还在
await gate.reload({ waitUntil: 'load' });
await gate.waitForTimeout(900);
const homeVisible = await gate.locator('#gate').isVisible();
const labelReload = (await gate.locator('#groupLabel').textContent()).trim();
const urlReload = await gate.evaluate(() => location.search);
console.log(`  刷新后：首页可见=${homeVisible}，顶栏=${labelReload}，地址栏=${urlReload}`);
if (homeVisible) errors.push('[锁定] 刷新后又回到了首页');
if (labelReload !== '第 4 组') errors.push(`[锁定] 刷新后组号变了：${labelReload}`);
if (!urlReload.includes('group=4')) errors.push(`[URL] 刷新后地址栏丢了组号（${urlReload}）`);

// 老师改 URL 就能改组（这是特意保留的口子）
await gate.goto(`${BASE}/?group=6`, { waitUntil: 'load' });
await gate.waitForTimeout(900);
const labelByUrl = (await gate.locator('#groupLabel').textContent()).trim();
const urlKept = await gate.evaluate(() => location.search);
console.log(`  老师把 URL 改成 ?group=6：顶栏=${labelByUrl}，地址栏=${urlKept}`);
if (labelByUrl !== '第 6 组') errors.push(`[URL] 改 URL 没有切换到第 6 组（${labelByUrl}）`);

// ?reset 回首页，并把组号从地址栏去掉
await gate.goto(`${BASE}/?reset`, { waitUntil: 'load' });
await gate.waitForTimeout(900);
const backHome = await gate.locator('#gate').isVisible();
const urlReset = await gate.evaluate(() => location.search);
console.log(`  ?reset：首页可见=${backHome}，地址栏=${urlReset || '(空)'}`);
if (!backHome) errors.push('[重置] ?reset 没有回到首页');
if (urlReset.includes('group=')) errors.push(`[重置] ?reset 之后地址栏还留着组号（${urlReset}）`);

await gate.close();

// 隐私模式：localStorage 被禁用（getter 直接抛）时，页面不能白屏，选组后仍然能用
console.log('隐私模式（localStorage 抛异常）');
const priv = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'zh-CN' });
await priv.addInitScript(() => {
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    get() { throw new Error('localStorage is blocked'); },
  });
});
const privPage = hook(await priv.newPage());
await privPage.goto(`${BASE}/?reset`, { waitUntil: 'load' });
await privPage.waitForTimeout(900);
const privHome = await privPage.locator('#gate').isVisible();
await privPage.locator('#groupGrid button:has-text("第 2 组")').click();
await privPage.waitForTimeout(900);
const privLabel = (await privPage.locator('#groupLabel').textContent()).trim();
const privCount = (await privPage.locator('#cubeCount').textContent()).trim();
const privExpected = (await stateOf(2)).length;
console.log(`  首页可见=${privHome}，进入后=${privLabel}，方块=${privCount}（服务器上是 ${privExpected} 块）`);
if (!privHome) errors.push('[隐私模式] 首页没有正常显示');
if (privLabel !== '第 2 组') errors.push(`[隐私模式] 无法进入组（${privLabel}）`);
if (privCount !== `${privExpected} 块`) {
  errors.push(`[隐私模式] 工作区数据不对（界面 ${privCount}，服务器 ${privExpected} 块）`);
}
await priv.close();

await desktop.close();
await browser.close();

// ---------------------------------------------------------------- 回归（另开浏览器，避开同源连接数限制）
const browser2 = await chromium.launch({ headless: true, executablePath });
const desktop2 = await browser2.newContext({
  viewport: { width: 1600, height: 1000 },
  deviceScaleFactor: 2,
  locale: 'zh-CN',
});
const newPage2 = async () => hook(await desktop2.newPage());

console.log('\n回归：移动后刷新还在（服务端真的存了）');
await post(5, [[2, 0, 2], [2, 1, 2], [2, 2, 2]]);
const stack = await newPage2();
await stack.goto(`${BASE}/?group=5`, { waitUntil: 'load' });
await stack.waitForTimeout(1200);
await stack.click('.tool-mode-btn:visible');   // 开启「移动木块」才能拖动
await stack.waitForTimeout(200);
const stackRect = await stack.locator('#scene').boundingBox();
const tower = await stateOf(5);
const topCell = tower[tower.length - 1];
const fromP = screenOfCell(stackRect, topCell, tower);
const toP = screenOfCell(stackRect, [0, 0, 0], tower, { ground: true });
await stack.mouse.move(fromP.x, fromP.y);
await stack.mouse.down();
await stack.mouse.move(toP.x, toP.y, { steps: 14 });
await stack.mouse.up();
await stack.waitForTimeout(1500);
const movedCubes = await stateOf(5);
await stack.reload({ waitUntil: 'load' });
await stack.waitForTimeout(1200);
const afterReload = await stateOf(5);
console.log(`  移动后：${JSON.stringify(movedCubes)}；刷新后读回：${JSON.stringify(afterReload)}`);
if (movedCubes.length !== 3) errors.push(`[回归] 移动后数量变了（${movedCubes.length}）`);
if (JSON.stringify(afterReload) !== JSON.stringify(movedCubes)) {
  errors.push('[回归] 移动后刷新，位置没有保存下来');
}

console.log('\n回归：键盘把选中的方块挪过去');
// 任务一现在"只能移动一块"，用独立的一组（任务一初始）单独测键盘，避免复用已移动过的组
await post(7, [[1, 0, 3], [1, 0, 2], [2, 0, 2], [3, 0, 2], [2, 0, 1], [1, 1, 2]], 1);
const kbPage = await newPage2();
await kbPage.goto(`${BASE}/?reset&group=7`, { waitUntil: 'load' });
await kbPage.waitForTimeout(1300);
const kbRect = await kbPage.locator('#scene').boundingBox();
const kbCubes = await stateOf(7);
await kbPage.click('.tool-mode-btn:visible');
await kbPage.waitForTimeout(200);
const kbPick = screenOfCell(kbRect, kbCubes[0], kbCubes);
await kbPage.mouse.click(kbPick.x, kbPick.y);
await kbPage.waitForTimeout(300);
const kbSelected = await kbPage.locator('#scene').getAttribute('data-selected');
await kbPage.locator('#scene').focus();
await kbPage.keyboard.press('ArrowRight');
await kbPage.keyboard.press('ArrowRight');
await kbPage.keyboard.press('Enter');
await kbPage.waitForTimeout(900);
const kbAfterCubes = await stateOf(7);
console.log(`  选中 ${JSON.stringify(kbSelected)}，回车后：${JSON.stringify(kbAfterCubes)}`);
if (kbAfterCubes.length !== 6) errors.push(`[键盘] 数量变了（${kbAfterCubes.length}）`);
if (JSON.stringify(kbAfterCubes) === JSON.stringify(kbCubes)) errors.push('[键盘] 回车没有移动选中的方块');
await kbPage.close();

console.log('\n回归：取景装得下 5 层');
await post(6, [[2, 0, 2], [2, 1, 2], [2, 2, 2], [2, 3, 2], [2, 4, 2]]);
const fiveTall = await newPage2();
await fiveTall.goto(`${BASE}/?group=6`, { waitUntil: 'load' });
await fiveTall.waitForTimeout(1200);
const tallRect = await fiveTall.locator('#scene').boundingBox();
const tallCubes = [[2, 0, 2], [2, 1, 2], [2, 2, 2], [2, 3, 2], [2, 4, 2]];
const aspect = tallRect.width / tallRect.height;
const cam = cameraFor(tallCubes);
const distance = fitDistance({
  fovDeg: FOV, aspect, center: cam.center, dir: DIR, min: [-2.5, 0, -2.5], max: [2.5, cam.top, 2.5],
});
const topNdc = projectNdc({
  point: [0.5, 5, 0.5], center: cam.center, dir: DIR, distance, fovDeg: FOV, aspect,
});
console.log(`  第 5 层顶面 NDC y=${topNdc.y.toFixed(2)}`);
if (Math.abs(topNdc.y) > 1) errors.push('[取景] 第 5 层仍在画面外');
await fiveTall.close();

await stack.close();

// 回归：同组另一个标签页切任务，不能把正在摆放的这台带走（任务跳转 bug）
console.log('\n回归：同组另一个标签切任务，不会把正在摆放的这台带走');
const jumpA = await newPage2();
await jumpA.goto(`${BASE}/?group=4`, { waitUntil: 'load' });
await jumpA.waitForTimeout(1000);
await jumpA.click('.task-tab[data-task="3"]');
await jumpA.waitForTimeout(900);
await jumpA.click('.tool-mode-btn:visible');           // 任务三进入「连续放置」
await jumpA.waitForTimeout(300);
const jumpBefore = (await jumpA.locator('.task-tab[aria-pressed="true"]').textContent()).trim();
const jumpB = await newPage2();
await jumpB.goto(`${BASE}/?group=4`, { waitUntil: 'load' });
await jumpB.waitForTimeout(1000);
await jumpB.click('.task-tab[data-task="1"]');   // 另一个标签页切到任务一（会写服务器 task=1）
await jumpB.waitForTimeout(2200);
const jumpAfter = (await jumpA.locator('.task-tab[aria-pressed="true"]').textContent()).trim();
const jumpCount = (await jumpA.textContent('#cubeCount')).trim();
console.log(`  摆放中的 A：${jumpBefore} → ${jumpAfter}，块数 ${jumpCount}`);
if (jumpBefore !== '任务三' || jumpAfter !== '任务三') {
  errors.push(`[跳转] 同组另一个标签切任务，把正在摆放的 A 带走了（${jumpBefore} → ${jumpAfter}）`);
}
await jumpB.close();
await jumpA.close();

// 回归：任务2 只能拿一个、任务3 只能添一个（按钮锁定 + 提示重置）
console.log('\n回归：任务2 只能拿一个 / 任务3 只能添一个');
const T_A = [[1, 0, 3], [1, 0, 2], [2, 0, 2], [3, 0, 2], [2, 0, 1], [1, 1, 2]];
const T_B = [[1, 0, 3], [1, 0, 2], [2, 0, 2], [2, 1, 2]];
await post(4, T_A, 1); await post(4, T_A, 2); await post(4, T_B, 3); await post(4, T_A, 1);
const rule = await newPage2();
await rule.goto(`${BASE}/?reset&group=4`, { waitUntil: 'load' });
await rule.waitForTimeout(1200);
// 任务2
await rule.click('.task-tab[data-task="2"]'); await rule.waitForTimeout(600);
let rbox = await rule.locator('#scene').boundingBox();
let rc = await stateOf(4);
await rule.click('.tool-mode-btn:visible'); await rule.waitForTimeout(200);
await rule.mouse.click(...Object.values(screenOfCell(rbox, [1, 1, 2], rc)));
await rule.waitForTimeout(700);
rc = await stateOf(4);
if (rc.length !== 5) errors.push(`[规则] 任务2 拿走一块应为 5 块（${rc.length}）`);
await rule.mouse.click(...Object.values(screenOfCell(rbox, [2, 0, 2], rc)));
await rule.waitForTimeout(500);
rc = await stateOf(4);
if (rc.length !== 5) errors.push(`[规则] 任务2 再拿应被阻止（${rc.length} 块）`);
if (!/只能拿走一个/.test((await rule.textContent('#guideToast')).trim())) errors.push('[规则] 任务2 再拿没有提示');
// 任务3
await rule.click('.task-tab[data-task="3"]'); await rule.waitForTimeout(600);
rbox = await rule.locator('#scene').boundingBox();
let r3 = await stateOf(4);
await rule.click('.tool-mode-btn:visible'); await rule.waitForTimeout(200);
await rule.mouse.click(...Object.values(screenOfCell(rbox, [4, 0, 4], r3, { ground: true })));
await rule.waitForTimeout(700);
r3 = await stateOf(4);
if (r3.length !== 5) errors.push(`[规则] 任务3 添一块应为 5 块（${r3.length}）`);
if ((await rule.locator('.tool-mode-btn[data-mode="place"]').getAttribute('data-locked')) !== 'true') {
  errors.push('[规则] 任务3 添完后「添上木块」按钮未锁定');
}
await rule.click('.tool-mode-btn[data-mode="place"]'); await rule.waitForTimeout(400);
if (!/只能添加一个/.test((await rule.textContent('#guideToast')).trim())) errors.push('[规则] 任务3 再添没有提示');
if ((await stateOf(4)).length !== 5) errors.push('[规则] 任务3 再添应被阻止');
await rule.close();

// 回归：练习模式（任务0）只有任务0，三个工具 + 重置可用
console.log('\n回归：练习模式（任务0）');
// 设置是服务器全局的：先让服务器进入练习模式，学生端刷新就会只显示任务0
await fetch(`${BASE}/api/settings`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'training' }),
});
const trainCtx = await browser2.newContext({ viewport: { width: 1400, height: 880 }, locale: 'zh-CN' });
await trainCtx.addInitScript(() => {
  try {
    localStorage.removeItem('cube-views:group');
    localStorage.removeItem('cube-views:task0');
  } catch { /* ignore */ }
});
const tpage = hook(await trainCtx.newPage());
await tpage.goto(`${BASE}/`, { waitUntil: 'load' });
await tpage.waitForTimeout(900);
// 任务0 也必须先选组（扫码→首页→选组）
if ((await tpage.locator('.task-tab:visible').count()) === 0) {
  await tpage.locator('#groupGrid button:has-text("第 2 组")').click();
  await tpage.waitForTimeout(900);
}
const tTabs = await tpage.locator('.task-tab:visible').allTextContents();
if (tTabs.length !== 1 || tTabs[0].trim() !== '任务0') errors.push(`[练习] 应只显示任务0（${tTabs.join('/')}）`);
if ((await tpage.locator('.tool-mode-btn:visible').count()) !== 3) errors.push('[练习] 应有移动/拿走/添上三个工具');
if ((await tpage.textContent('#cubeCount')).trim() !== '4 块') errors.push('[练习] 初始应为 4 块');
const tbox = await tpage.locator('#scene').boundingBox();
const tInit = [[1, 0, 2], [2, 0, 2], [3, 0, 2], [1, 1, 2]];
await tpage.click('.tool-mode-btn[data-mode="erase"]'); await tpage.waitForTimeout(200);
await tpage.mouse.click(...Object.values(screenOfCell(tbox, [2, 0, 2], tInit)));
await tpage.waitForTimeout(400);
if ((await tpage.textContent('#cubeCount')).trim() !== '3 块') errors.push('[练习] 拿走一块应为 3 块');
await tpage.click('#resetBtn'); await tpage.waitForTimeout(300);
if ((await tpage.textContent('#cubeCount')).trim() !== '4 块') errors.push('[练习] 重置应回到 4 块');
await tpage.close();
await trainCtx.close();
// 测试完把服务器设置恢复成正式任务，避免影响后续/线上
await fetch(`${BASE}/api/settings`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'formal' }),
});

// 回归：任务一只能移动一块（移完标粉+锁定，要再移需重置）
console.log('\n回归：任务一只能移动一块');
await post(8, T_A, 1);
const mv = await newPage2();
await mv.goto(`${BASE}/?reset&group=8`, { waitUntil: 'load' });
await mv.waitForTimeout(1300);
let mbox = await mv.locator('#scene').boundingBox();
const mCubes = await stateOf(8);
await mv.click('.tool-mode-btn:visible');            // 移动木块
await mv.waitForTimeout(200);
const topM = mCubes.reduce((b, c) => (c[1] > b[1] ? c : b), mCubes[0]);
await mv.mouse.click(...Object.values(screenOfCell(mbox, topM, mCubes)));
await mv.waitForTimeout(300);
await mv.mouse.click(...Object.values(screenOfCell(mbox, [4, 0, 4], mCubes, { ground: true })));
await mv.waitForTimeout(900);
const mAfter = await stateOf(8);
if (mAfter.length !== 6 || !mAfter.some((c) => c[0] === 4 && c[1] === 0 && c[2] === 4)) {
  errors.push(`[任务一] 移动一块后应为 6 块且含 [4,0,4]（${JSON.stringify(mAfter)}）`);
}
const mLocked = await mv.locator('.tool-mode-btn[data-mode="move"]').getAttribute('data-locked');
if (mLocked !== 'true') errors.push('[任务一] 移动一块后「移动木块」未锁定');
await mv.click('.tool-mode-btn[data-mode="move"]');
await mv.waitForTimeout(400);
if (!/只能移动一个/.test((await mv.textContent('#guideToast')).trim())) errors.push('[任务一] 再移没有提示需重置');
// 再尝试移动另一块（点击另一块再点空位）应无效
await mv.mouse.click(...Object.values(screenOfCell(mbox, mAfter[0], mAfter)));
await mv.waitForTimeout(200);
await mv.mouse.click(...Object.values(screenOfCell(mbox, [0, 0, 4], mAfter, { ground: true })));
await mv.waitForTimeout(500);
if ((await stateOf(8)).length !== 6) errors.push('[任务一] 锁定后数量应仍为 6');
// 重置解锁
await mv.click('#resetBtn'); await mv.waitForTimeout(700);
if ((await mv.locator('.tool-mode-btn[data-mode="move"]').getAttribute('data-locked')) === 'true') {
  errors.push('[任务一] 重置后「移动木块」仍锁定');
}
await mv.close();

// ---------------------------------------------------------------- 收尾
const T1_CLEAN = [[1, 0, 3], [1, 0, 2], [2, 0, 2], [3, 0, 2], [2, 0, 1], [1, 1, 2]];
const T3_CLEAN = [[1, 0, 3], [1, 0, 2], [2, 0, 2], [2, 1, 2]];
for (let i = 1; i <= 8; i++) {
  await post(i, T1_CLEAN, 1);
  await post(i, T1_CLEAN, 2);
  await post(i, T3_CLEAN, 3);
  await post(i, T1_CLEAN, 1);
}
console.log(`\n已恢复每个组为任务一初始：${(await Promise.all([1, 2, 3, 4, 5, 6, 7, 8].map((i) => stateOf(i)))).map((c) => c.length).join('/')}`);

await browser2.close();
await desktop2.close();

console.log('\n结果：');
if (errors.length) {
  for (const e of errors) console.log(`  ✗ ${e}`);
  process.exitCode = 1;
} else {
  console.log('  ✓ 全部通过');
}
