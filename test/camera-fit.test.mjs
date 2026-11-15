/**
 * 取景数学的单元测试。
 * 锁住"整个 5×5×5 可玩范围必须都在画面里"这条约束 —— 独立复核就是在这里
 * 发现第 5 层被切掉、窄屏还会切掉左右两列的。
 */
import assert from 'node:assert/strict';
import { fitDistance, projectNdc, cameraBasis } from '../public/js/student/camera-fit.js';

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}\n    ${err.message}`);
    process.exitCode = 1;
  }
}

// 与 stage.js 保持一致
const FOV = 38;
const CENTER = [0, 2.3, 0];
const RAW = [5.7, 4.4, 7.3];
const LEN = Math.hypot(...RAW);
const DIR = RAW.map((v) => v / LEN);
const MIN = [-2.5, 0, -2.5];
const MAX = [2.5, 5, 2.5];

const corners = [];
for (const x of [MIN[0], MAX[0]]) {
  for (const y of [MIN[1], MAX[1]]) {
    for (const z of [MIN[2], MAX[2]]) corners.push([x, y, z]);
  }
}

const ASPECTS = [0.5, 0.6, 0.72, 0.84, 1.0, 1.33, 1.6, 2.0, 2.4];

console.log('相机取景测试');

check('基向量正交且为单位长度', () => {
  const { fwd, right, up } = cameraBasis(DIR);
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  for (const v of [fwd, right, up]) {
    assert.ok(Math.abs(Math.hypot(...v) - 1) < 1e-9, '单位向量');
  }
  assert.ok(Math.abs(dot(fwd, right)) < 1e-9);
  assert.ok(Math.abs(dot(fwd, up)) < 1e-9);
  assert.ok(Math.abs(dot(right, up)) < 1e-9);
  assert.ok(up[1] > 0, 'up 应该朝上');
});

check('任何宽高比下，可玩范围的八个角都在画面内', () => {
  for (const aspect of ASPECTS) {
    const distance = fitDistance({
      fovDeg: FOV, aspect, center: CENTER, dir: DIR, min: MIN, max: MAX,
    });
    for (const point of corners) {
      const ndc = projectNdc({ point, center: CENTER, dir: DIR, distance, fovDeg: FOV, aspect });
      assert.ok(ndc.depth > 0, `${aspect}: 角点跑到相机后面去了`);
      assert.ok(
        Math.abs(ndc.x) <= 1 && Math.abs(ndc.y) <= 1,
        `${aspect}: 角点 (${point}) 出界 x=${ndc.x.toFixed(2)} y=${ndc.y.toFixed(2)}`,
      );
    }
  }
});

check('取景距离随画面变窄而变远（窄屏要靠后退才能装下）', () => {
  const wide = fitDistance({ fovDeg: FOV, aspect: 2.0, center: CENTER, dir: DIR, min: MIN, max: MAX });
  const narrow = fitDistance({ fovDeg: FOV, aspect: 0.6, center: CENTER, dir: DIR, min: MIN, max: MAX });
  assert.ok(narrow > wide, `窄屏应更远：${narrow.toFixed(2)} vs ${wide.toFixed(2)}`);
});

check('取景距离在合理区间（不会贴脸，也不会远成芝麻）', () => {
  // 极窄的窗口（宽高比 0.5）必须退得比较远才能把整个地面装下，这是几何必然；
  // 我们选择"宁可小一点也不要看不见" —— 学生滚轮可以随时拉近。
  for (const aspect of ASPECTS) {
    const d = fitDistance({ fovDeg: FOV, aspect, center: CENTER, dir: DIR, min: MIN, max: MAX });
    assert.ok(d > 4.5, `${aspect}: 太近 ${d.toFixed(2)}`);
    assert.ok(d < 26, `${aspect}: 太远 ${d.toFixed(2)}`);
  }
});

check('回归：旧的固定距离（10.25）确实装不下第 5 层', () => {
  // 旧版本 HOME_TARGET 是 (0,1,0)，距离 ≈10.25
  const oldCenter = [0, 1, 0];
  const distance = Math.hypot(...RAW);   // 10.25
  const top = projectNdc({
    point: [2.5, 5, 2.5], center: oldCenter, dir: DIR, distance, fovDeg: FOV, aspect: 1.6,
  });
  assert.ok(top.y > 1, `旧取景下第 5 层顶角应出界，实际 y=${top.y.toFixed(2)}`);
});

check('第 5 层顶面在默认取景下留有余量（不是刚好贴边）', () => {
  const aspect = 1.6;
  const distance = fitDistance({ fovDeg: FOV, aspect, center: CENTER, dir: DIR, min: MIN, max: MAX });
  const lowest = Math.min(...corners.map((point) => {
    const ndc = projectNdc({ point, center: CENTER, dir: DIR, distance, fovDeg: FOV, aspect });
    return 1 - Math.abs(ndc.y);
  }));
  assert.ok(lowest > 0, '都应留有余量');
});

console.log(`\n${passed} 项通过${process.exitCode ? '，有失败项' : ''}`);
