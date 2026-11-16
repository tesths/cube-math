/**
 * 共享数据模型：坐标约定、合法性校验、三视图投影。
 *
 * 纯 ESM、零依赖，同时被浏览器端与 Node 端 import（服务器用它校验学生提交的数据）。
 *
 * 坐标约定（右手系，单位 = 一个正方体边长）：
 *   x 向右为正，0..4（5 列）
 *   y 向上为正，0..4（最高 5 层）
 *   z 朝向观察者（前方）为正，0..4（z=0 是最后排，z=4 是最前排）
 *
 * 立方体用 [x, y, z] 表示，整个小组的状态就是一组这样的坐标。
 */

export const LIMITS = Object.freeze({ sizeX: 5, sizeY: 5, sizeZ: 5 });

// ---------------------------------------------------------------- 课堂任务

/**
 * 任务0 = 练习（熟悉平板）：移动 / 拿走 / 添上 三种操作都能用，四个按钮都有。
 * 任务一 = 移动木块（方块数量不变）
 * 任务二 = 拿走木块（只会减少）
 * 任务三 = 添上木块（只会增加）
 *
 * 注意：任务0 只在学生端“练习模式”里本地使用，不写入服务器（见 app.js）；
 * 服务器正式的三个任务仍是 1/2/3。
 */
export const TASKS = Object.freeze({
  0: { id: 0, name: '任务0', action: 'move', actionLabel: '移动木块', practice: true },
  1: { id: 1, name: '任务一', action: 'move', actionLabel: '移动木块' },
  2: { id: 2, name: '任务二', action: 'erase', actionLabel: '拿走木块' },
  3: { id: 3, name: '任务三', action: 'place', actionLabel: '添上木块' },
});

export const TASK_COUNT = 3;

/** 把任意输入收敛成 0..3 的任务号（非法值按任务一） */
export function normalizeTask(value) {
  const n = Number(value);
  return n === 0 || n === 1 || n === 2 || n === 3 ? n : 1;
}

export function taskMeta(value) {
  return TASKS[normalizeTask(value)];
}

/*
 * 图形都放在中间的 3×3 里（x、z 都是 1..3），层数自下往上。
 * 地面上的「正面」= +z，所以数组行序是"从最前面一行(z=3)到最后面一行(z=1)"，
 * 每行从左到右 x=1..3。
 *
 * 任务一 / 任务二的第一层：
 *   1 0 0      →  (1,0,3)   最前面一行只有左边一块
 *   1 1 1      →  (1,0,2) (2,0,2) (3,0,2)
 *   0 1 0      →  (2,0,1)   最后面一行只有中间一块
 * 第二层：
 *   0 0 0
 *   1 0 0      →  (1,1,2)
 *   0 0 0
 */
const FIGURE_A = [
  [1, 0, 3], [1, 0, 2], [2, 0, 2], [3, 0, 2], [2, 0, 1],
  [1, 1, 2],
];

/*
 * 任务三（初始摆放 = 完成态，4 块）的第一层：
 *   1 0 0      →  (1,0,3)   最前面一行左边一块
 *   1 1 0      →  (1,0,2) (2,0,2)
 *   0 0 0
 * 第二层：
 *   0 0 0
 *   0 1 0      →  (2,1,2)   5×5 正中间那格再叠一块
 *   0 0 0
 */
const FIGURE_B = [
  [1, 0, 3], [1, 0, 2], [2, 0, 2],
  [2, 1, 2],
];

/*
 * 任务0（练习）的图形，按老师给的矩阵：
 * 第一层          第二层
 *   0 0 0           0 0 0
 *   1 1 1           1 0 0
 *   0 0 0           0 0 0
 * 行序是"最前(z=3) → 最后(z=1)"，所以：
 *   第一层中间一行三块 → (1,0,2) (2,0,2) (3,0,2)
 *   第二层中间一行左边一块 → (1,1,2)
 */
const FIGURE_0 = [
  [1, 0, 2], [2, 0, 2], [3, 0, 2],
  [1, 1, 2],
];

/** 某任务的"初始摆放"（任务三初始就是完整 4 块；任务0 为练习图形） */
export function taskInitial(value) {
  const id = normalizeTask(value);
  if (id === 0) return FIGURE_0.map((c) => [...c]);
  if (id === 3) return FIGURE_B.map((c) => [...c]);
  return FIGURE_A.map((c) => [...c]);
}

/** 某任务的"完成态"（暂时只用于以后做完成判定，界面先不比对） */
export function taskTarget(value) {
  const id = normalizeTask(value);
  if (id === 0) return FIGURE_0.map((c) => [...c]);
  return (id === 3 ? FIGURE_B : FIGURE_A).map((c) => [...c]);
}

/** 兼容旧调用：不指定任务时，用任务一的初始摆放 */
export function defaultCubes() {
  return taskInitial(1);
}

/**
 * "被操作过、需要标色的方块"（教师端也会同步显示粉色）：
 *   - 任务三（添上）：比初始 4 块多出来的那块 = 学生新添的；
 *   - 任务一（移动）：比初始位置多的那格 = 学生移动后的新位置（只允许移动 1 块）；
 *   - 其它任务没有"新增位置"概念，返回空。
 */
export function extraCells(task, cubes) {
  const id = normalizeTask(task);
  if (id !== 1 && id !== 3) return [];
  const init = new Set(taskInitial(id).map((c) => c.join(',')));
  return (cubes ?? []).filter((c) => !init.has(c.join(',')));
}

/** 坐标 -> Set 里用的字符串键 */
export function keyOf(x, y, z) {
  return `${x},${y},${z}`;
}

/** 是否在允许的空间范围内（要求整数） */
export function isInside(x, y, z) {
  return (
    Number.isInteger(x) && Number.isInteger(y) && Number.isInteger(z) &&
    x >= 0 && x < LIMITS.sizeX &&
    y >= 0 && y < LIMITS.sizeY &&
    z >= 0 && z < LIMITS.sizeZ
  );
}

/** 转换成键集合，便于判断某格是否被占用 */
export function toKeySet(cubes) {
  const set = new Set();
  for (const [x, y, z] of cubes) set.add(keyOf(x, y, z));
  return set;
}

/**
 * 宽松清洗：只去格式错、越界、重复，**不判悬空**。
 *
 * 交互过程中必须用这个而不是 sanitizeCubes：学生把柱子的底层方块拿走时，
 * 上面的方块应该"塌下来"落在地上；如果先按悬空规则丢掉它们，
 * 一列方块就会整列消失（拿一块丢一根柱子）。
 * 顺序永远是：sanitizeLoose -> collapseColumns。
 */
export function sanitizeLoose(input) {
  const raw = Array.isArray(input) ? input : [];
  const seen = new Set();
  const cubes = [];
  let dropped = 0;

  for (const item of raw) {
    if (!Array.isArray(item) || item.length < 3) { dropped++; continue; }
    const [x, y, z] = item.map(Number);
    if (!isInside(x, y, z)) { dropped++; continue; }
    const k = keyOf(x, y, z);
    if (seen.has(k)) { dropped++; continue; }
    seen.add(k);
    cubes.push([x, y, z]);
  }

  cubes.sort((a, b) => (a[2] - b[2]) || (a[1] - b[1]) || (a[0] - b[0]));
  return { cubes, dropped };
}

/**
 * 把任意外部输入整理成合法立方体列表。
 * 会丢掉：格式不对的、坐标非整数、越界的、重复的，以及"悬空"的方块。
 * 返回 { cubes, dropped }，cubes 按 z,y,x 排序（便于稳定比较与落盘）。
 *
 * 注意：这是**服务器侧、面向外部输入**的严格规则；学生端交互请用
 * sanitizeLoose + collapseColumns，否则会误伤整列方块。
 */
export function sanitizeCubes(input) {
  const { cubes: candidates, dropped: stage1 } = sanitizeLoose(input);
  let dropped = stage1;

  // 去掉悬空方块：按 y 从小到大处理，下面的方块先落地
  const settled = new Set();
  const cubes = [];
  for (const [x, y, z] of candidates) {
    if (y === 0 || settled.has(keyOf(x, y - 1, z))) {
      settled.add(keyOf(x, y, z));
      cubes.push([x, y, z]);
    } else {
      dropped++;
    }
  }

  cubes.sort((a, b) => (a[2] - b[2]) || (a[1] - b[1]) || (a[0] - b[0]));
  return { cubes, dropped };
}

/** 面向外部输入的严格校验，返回错误信息数组（空数组 = 合法） */
export function validateCubes(input) {
  const errors = [];
  if (!Array.isArray(input)) return ['cubes 必须是数组'];
  if (input.length > LIMITS.sizeX * LIMITS.sizeY * LIMITS.sizeZ) {
    errors.push('方块数量超出上限');
  }
  const { dropped } = sanitizeCubes(input);
  if (dropped > 0) errors.push(`有 ${dropped} 个方块不合法（越界、重复或悬空）`);
  return errors;
}

/**
 * 三视图投影。
 *
 * 每个视图返回 { cols, rows, cells, count }：
 *   cells[row][col] === true 表示该格要涂色；row 0 是最上面一行。
 *   图形只覆盖实际占用的最小包围盒；没有方块时返回 null。
 *
 * 观察者与画面方向（推导见 REQUIREMENTS.md §5）：
 *   从正面看：观察者在 +z，视线朝 -z，画面向右 = +x，向上 = +y
 *   从右面看：观察者在 +x，视线朝 -x，画面向右 = -z，向上 = +y
 *   从上面看：观察者在 +y 上方，画面向右 = +x，向上 = -z（后方在上）
 */
export function viewFromFront(cubes) {
  // 画面纵轴 = y，y 越大越靠上
  return buildView(cubes, (c) => c[0], (c) => c[1], true);
}

export function viewFromRight(cubes) {
  // 观察者在 +x 往 -x 看：画面向右 = -z，向上 = +y
  return buildView(cubes, (c) => -c[2], (c) => c[1], true);
}

export function viewFromTop(cubes) {
  // 俯视图：画面纵轴 = z，但 z 越大（越靠前）越靠下 —— 后方在画面上方
  return buildView(cubes, (c) => c[0], (c) => c[2], false);
}

/**
 * 通用投影：入参为立方体数组，horizontal/vertical 分别给出某立方体在
 * 画面横轴、纵轴上的格坐标。同一画面格上只要存在任意深度的立方体就涂色。
 *
 * @param {boolean} verticalUp 画面纵轴取值增大时是否更靠上
 */
function buildView(cubes, horizontal, vertical, verticalUp) {
  if (!Array.isArray(cubes) || cubes.length === 0) return null;

  let minH = Infinity, maxH = -Infinity, minV = Infinity, maxV = -Infinity;
  for (const c of cubes) {
    const h = horizontal(c), v = vertical(c);
    if (h < minH) minH = h;
    if (h > maxH) maxH = h;
    if (v < minV) minV = v;
    if (v > maxV) maxV = v;
  }

  const cols = maxH - minH + 1;
  const rows = maxV - minV + 1;
  const cells = Array.from({ length: rows }, () => Array(cols).fill(false));

  for (const c of cubes) {
    const col = horizontal(c) - minH;
    const row = verticalUp ? (maxV - vertical(c)) : (vertical(c) - minV);
    cells[row][col] = true;
  }

  let filled = 0;
  for (const row of cells) for (const on of row) if (on) filled++;

  return { cols, rows, cells, filled };
}

/** 三个视图一次性算好 */
export function computeViews(cubes) {
  return {
    front: viewFromFront(cubes),
    right: viewFromRight(cubes),
    top: viewFromTop(cubes),
  };
}

/**
 * 重力塌落：每个竖列重新从地面往上码。
 * 拿掉下层方块时上面的方块自然落下 —— 对学生来说这比"悬空"好理解得多，
 * 也保证了图形始终满足"不悬空"这条规则。
 */
export function collapseColumns(cubes) {
  const heights = new Map(); // "x,z" -> 方块个数
  for (const [x, , z] of cubes) {
    const k = `${x},${z}`;
    heights.set(k, Math.min((heights.get(k) ?? 0) + 1, LIMITS.sizeY));
  }

  const out = [];
  for (const [k, h] of heights) {
    const [x, z] = k.split(',').map(Number);
    for (let y = 0; y < h; y++) out.push([x, y, z]);
  }
  out.sort((a, b) => (a[2] - b[2]) || (a[1] - b[1]) || (a[0] - b[0]));
  return out;
}

/** 每列高度表，键 "x,z"，值 = 该列方块个数 */
export function columnHeights(cubes) {
  const heights = new Map();
  for (const [x, , z] of cubes) {
    const k = `${x},${z}`;
    heights.set(k, (heights.get(k) ?? 0) + 1);
  }
  return heights;
}

/** 包围盒，主要用于展示"占地多大" */
export function boundingBox(cubes) {
  if (!cubes || cubes.length === 0) return null;
  const box = {
    minX: Infinity, maxX: -Infinity,
    minY: Infinity, maxY: -Infinity,
    minZ: Infinity, maxZ: -Infinity,
  };
  for (const [x, y, z] of cubes) {
    box.minX = Math.min(box.minX, x); box.maxX = Math.max(box.maxX, x);
    box.minY = Math.min(box.minY, y); box.maxY = Math.max(box.maxY, y);
    box.minZ = Math.min(box.minZ, z); box.maxZ = Math.max(box.maxZ, z);
  }
  return box;
}
