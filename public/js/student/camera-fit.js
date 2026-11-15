/**
 * 相机取景的纯数学：要让一整个立方体范围都装进画面，相机该离中心多远。
 *
 * 不依赖 three.js（只做向量运算），所以能在 Node 里直接做单元测试 ——
 * 之前"第 5 层被切掉"就是靠这套数学在测试里锁住的。
 */

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const norm = (a) => {
  const len = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / len, a[1] / len, a[2] / len];
};

/** 由"中心 -> 相机"的方向算出相机基向量 */
export function cameraBasis(dir, worldUp = [0, 1, 0]) {
  const fwd = norm([-dir[0], -dir[1], -dir[2]]);
  const right = norm(cross(fwd, worldUp));
  const up = norm(cross(right, fwd));
  return { fwd, right, up };
}

/**
 * 算出装下范围所需的最小相机距离（沿 dir 方向离开 center）。
 *
 * 对范围八个角逐一施加"必须在视锥内"的约束：
 *   |x_cam| ≤ tan(hFov/2) · depth，|y_cam| ≤ tan(vFov/2) · depth
 * 其中 x_cam/y_cam 与距离无关，depth = depth₀ + d，于是每个角给出一个 d 的下界。
 */
export function fitDistance({ fovDeg, aspect, center, dir, min, max, margin = 1.05 }) {
  const { fwd, right, up } = cameraBasis(dir);
  const vTan = Math.tan((fovDeg * Math.PI) / 180 / 2);
  const hTan = vTan * aspect;

  let distance = 0;
  for (const x of [min[0], max[0]]) {
    for (const y of [min[1], max[1]]) {
      for (const z of [min[2], max[2]]) {
        const p = sub([x, y, z], center);
        const depth0 = dot(p, fwd);
        const needY = Math.abs(dot(p, up)) / vTan - depth0;
        const needX = Math.abs(dot(p, right)) / hTan - depth0;
        distance = Math.max(distance, needX, needY);
      }
    }
  }
  return distance * margin;
}

/** 把世界坐标点投影成 NDC（-1..1 即在画面内），用于测试与调试 */
export function projectNdc({ point, center, dir, distance, fovDeg, aspect }) {
  const { fwd, right, up } = cameraBasis(dir);
  const camPos = [
    center[0] + dir[0] * distance,
    center[1] + dir[1] * distance,
    center[2] + dir[2] * distance,
  ];
  const v = sub(point, camPos);
  const depth = dot(v, fwd);
  const vTan = Math.tan((fovDeg * Math.PI) / 180 / 2);
  const hTan = vTan * aspect;
  return {
    x: dot(v, right) / (depth * hTan),
    y: dot(v, up) / (depth * vTan),
    depth,
  };
}
