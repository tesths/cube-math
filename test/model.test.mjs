/**
 * 三视图投影的单元测试（手工推导的期望值）。
 * 运行：npm test   （或 node test/model.test.mjs）
 */
import assert from 'node:assert/strict';
import {
  sanitizeCubes,
  sanitizeLoose,
  validateCubes,
  viewFromFront,
  viewFromRight,
  viewFromTop,
  computeViews,
  collapseColumns,
  columnHeights,
} from '../public/js/shared/model.js';

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

/** 把视图的 cells 转成 '#'/'·' 字符串，方便人眼比对 */
function render(view) {
  if (!view) return '(空)';
  return view.cells.map((row) => row.map((on) => (on ? '#' : '·')).join('')).join('\n');
}

console.log('三视图投影测试');

// 经典形状：地面上一条 3 连 + 前面一块，再在最左上的位置叠一块
// (0,0,0) (1,0,0) (2,0,0) (0,0,1) + (0,1,0)
const shape = [[0, 0, 0], [1, 0, 0], [2, 0, 0], [0, 0, 1], [0, 1, 0]];

check('从正面看：宽 3 高 2，左列两层', () => {
  const v = viewFromFront(shape);
  assert.equal(v.cols, 3);
  assert.equal(v.rows, 2);
  assert.equal(render(v), ['#··', '###'].join('\n'));
});

check('从右面看：画面向右 = -z（z=1 在左、z=0 在右）', () => {
  const v = viewFromRight(shape);
  assert.equal(v.cols, 2);
  assert.equal(v.rows, 2);
  assert.equal(render(v), ['·#', '##'].join('\n'));
});

check('从上面看：后方在上，z=0 有 3 块、z=1 有 1 块', () => {
  const v = viewFromTop(shape);
  assert.equal(v.cols, 3);
  assert.equal(v.rows, 2);
  assert.equal(render(v), ['###', '#··'].join('\n'));
});

check('单个方块：三个视图都是 1×1', () => {
  const { front, right, top } = computeViews([[2, 0, 3]]);
  for (const v of [front, right, top]) {
    assert.equal(v.cols, 1);
    assert.equal(v.rows, 1);
    assert.equal(render(v), '#');
  }
});

check('空状态返回 null', () => {
  assert.equal(viewFromFront([]), null);
  assert.equal(viewFromTop(null), null);
});

check('悬空方块会被丢弃', () => {
  const { cubes, dropped } = sanitizeCubes([[0, 2, 0], [1, 0, 1]]);
  assert.equal(dropped, 1);
  assert.deepEqual(cubes, [[1, 0, 1]]);
});

check('叠放：只有下面有块时才允许上面有块', () => {
  const { cubes, dropped } = sanitizeCubes([[0, 0, 0], [0, 1, 0], [0, 2, 0]]);
  assert.equal(dropped, 0);
  assert.equal(cubes.length, 3);
});

check('重复、越界、非整数一律丢弃', () => {
  const { cubes, dropped } = sanitizeCubes([
    [0, 0, 0], [0, 0, 0], [9, 0, 0], [1.5, 0, 0], 'x', [1, 0, 0], null,
  ]);
  assert.deepEqual(cubes, [[0, 0, 0], [1, 0, 0]]);
  assert.equal(dropped, 5);
});

check('校验函数能报告不合法输入', () => {
  assert.deepEqual(validateCubes([[0, 0, 0]]), []);
  assert.equal(validateCubes('nope').length, 1);
  assert.equal(validateCubes([[0, 5, 0]]).length, 1);
});

check('从右面看只看 z，和 x 无关', () => {
  const a = viewFromRight([[0, 0, 0], [0, 0, 1]]);
  const b = viewFromRight([[2, 0, 0], [2, 0, 1]]);
  assert.deepEqual(a.cells, b.cells);
  assert.equal(a.cols, 2);
});

// 学生端 commit() 用的就是这条链路：宽松清洗 -> 重力塌落
const pipeline = (next) => collapseColumns(sanitizeLoose(next).cubes);

check('交互管线：抽掉三层柱的底层，剩下两块落在地上（不是整列消失）', () => {
  const tower = [[0, 0, 0], [0, 1, 0], [0, 2, 0]];
  const removedBottom = tower.filter((c) => c[1] !== 0);
  assert.deepEqual(pipeline(removedBottom), [[0, 0, 0], [0, 1, 0]]);
});

check('交互管线：抽掉中层，上层落下来补位', () => {
  const tower = [[0, 0, 0], [0, 1, 0], [0, 2, 0]];
  assert.deepEqual(pipeline(tower.filter((c) => c[1] !== 1)), [[0, 0, 0], [0, 1, 0]]);
});

check('交互管线：把底层拖到别格，源列剩两块、目标列一块', () => {
  const tower = [[0, 0, 0], [0, 1, 0], [0, 2, 0]];
  const moved = [...tower.filter((c) => c[1] !== 0), [4, 0, 4]];
  const after = pipeline(moved);
  assert.equal(after.length, 3);
  assert.deepEqual(after.filter((c) => c[0] === 0), [[0, 0, 0], [0, 1, 0]]);
  assert.deepEqual(after.filter((c) => c[0] === 4), [[4, 0, 4]]);
});

check('回归：严格清洗会吞掉整列 —— 所以交互不能用它', () => {
  const tower = [[0, 0, 0], [0, 1, 0], [0, 2, 0]];
  const strict = collapseColumns(sanitizeCubes(tower.filter((c) => c[1] !== 0)).cubes);
  assert.deepEqual(strict, [], '这正是不该在交互里用 sanitizeCubes 的原因');
});

check('重力塌落：抽掉下面一块，上面的方块落到地面', () => {
  // 一列三层，去掉最下面那块 —— 位置模型里就是"这一列少了一块"
  const stacked = [[1, 0, 1], [1, 1, 1], [1, 2, 1]];
  const removed = stacked.filter((c) => !(c[0] === 1 && c[1] === 0 && c[2] === 1));
  const fallen = collapseColumns(removed);
  assert.deepEqual(fallen, [[1, 0, 1], [1, 1, 1]]);
  assert.equal(validateCubes(fallen).length, 0);
});

check('重力塌落后的图形永远不悬空', () => {
  for (const cubes of [shape, [[2, 3, 2], [2, 4, 2]], [[0, 1, 0], [4, 1, 4], [2, 1, 2]]]) {
    const collapsed = collapseColumns(cubes);
    assert.deepEqual(validateCubes(collapsed), [], `未通过：${JSON.stringify(cubes)}`);
  }
});

check('对本来就合法的图形，塌落是恒等操作（幂等）', () => {
  for (const cubes of [shape, [[2, 0, 2], [2, 1, 2], [2, 2, 2]]]) {
    const once = collapseColumns(cubes);
    assert.deepEqual(once, collapseColumns(once));
    assert.deepEqual(once.slice().sort(), cubes.slice().sort());
  }
});

check('列高统计与投影一致：俯视图涂色格数 = 有方块的列数', () => {
  const heights = columnHeights(shape);
  const top = viewFromTop(shape);
  assert.equal(heights.size, top.filled);
});

console.log(`\n${passed} 项通过${process.exitCode ? '，有失败项' : ''}`);
