/**
 * 3D 舞台的共享外观 / 角度约定。
 *
 * 学生端舞台、教师端放大演示、教师端小卡片都用这一套：
 *   - VIEW_ANGLES：转视角的角度边界。OrbitControls（右键 / 双指）和「视角球」的
 *     orbitBy() 必须夹在**同一组**边界里，否则一个能转到位、另一个会被 update() 弹回来。
 *   - CUBE_FACE / makeEdgeMaterial()：1px 黑色描边与「面往后推」的深度设置，
 *     让描边和地面方格线同量级，又不会像以前那样和面抢深度、忽隐忽现。
 *   - HOME_ANGLES / MIN_FIT_TOP / FRAME_LIFT_RATIO：起始角度与取景尺寸，三处共用。
 *   - logViewAngles()：往 DevTools 打一条可读的角度日志，方便核对"到底转到了哪儿"。
 *
 * 浏览器模块（依赖 three），不参与 Node 端的单元测试。
 */
import * as THREE from 'three';

/**
 * 角度边界（弧度），以教材三视图为准：
 *   方位角 θ（水平，从 +z 轴量起）：0° = 正对「正面」，90° = 正对「右面」
 *   俯仰角 φ（与竖直 y 轴的夹角）：0° = 正上方（俯视图），90° = 平视（主视图 / 右视图）
 *
 * 起始视角见 HOME_ANGLES（俯仰 80° / 方位 10°，几乎正对「正面」）。
 * 之前 maxPolarAngle 卡在 45°（和旧默认视角一模一样），往平视方向一点都转不动，
 * 学生也没法把立体图转成和「从前面看 / 从右面看」一致的角度 —— 这就是"角度不对"的根因。
 * 两端各留一点余量：正上方留 0.08 避免万向锁，平视留 0.07 避免钻到地面以下。
 */
export const VIEW_ANGLES = Object.freeze({
  azimuthMin: 0,
  azimuthMax: Math.PI / 2,
  polarMin: 0.08,                   // ≈ 4.6°
  polarMax: Math.PI / 2 - 0.07,     // ≈ 86°
});

/**
 * 起始视角（也是「复位视角」回去的角度）：俯仰角 80°、方位角 10°。
 * 也就是几乎正对「正面」、只比平视高 10° —— 一进来就和「从前面看」对齐。
 */
export const HOME_ANGLES = Object.freeze({
  azimuth: (10 * Math.PI) / 180,
  polar: (80 * Math.PI) / 180,
});

/** 由 HOME_ANGLES 生成「中心 -> 相机」的单位方向（three.js 球坐标约定） */
export function homeDirection() {
  const { polar, azimuth } = HOME_ANGLES;
  return new THREE.Vector3(
    Math.sin(polar) * Math.sin(azimuth),
    Math.cos(polar),
    Math.sin(polar) * Math.cos(azimuth),
  ).normalize();
}

/** 视角球每拖动 1px 转多少弧度（≈0.52°/px，与 OrbitControls 右键拖动的手感接近） */
export const ORBIT_SPEED = 0.009;

/**
 * 取景：学生端、教师端放大演示、教师端 8 张小卡片必须共用这一套，
 * 否则「同一个图形」在两块屏幕上看起来角度 / 高低都不一样。
 */
export const MIN_FIT_TOP = 3.2;
/** 画面上移量：把视线中心从内容中线再压低这个比例，积木就落在画面偏上的位置。
 *  现在最多只有两三层积木，上方留白太多，所以从 0.05 提到 0.2。 */
export const FRAME_LIFT_RATIO = 0.2;

/** 当前内容最高到第几层时，取景框用多高（矮时也别把画面缩成一粒芝麻） */
export function frameTop(contentTop) {
  return Math.max(MIN_FIT_TOP, contentTop + 0.9);
}

/** 取景中心：越低，画面里的积木越靠上 */
export function frameCenter(top) {
  return new THREE.Vector3(0, top / 2 - top * FRAME_LIFT_RATIO, 0);
}

export const deg = (rad) => `${(rad * 180 / Math.PI).toFixed(1)}°`;
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** 当前相机相对 target 的球坐标，theta=方位角、phi=俯仰角 */
export function viewAngles(camera, target) {
  const offset = new THREE.Vector3().subVectors(camera.position, target);
  const s = new THREE.Spherical().setFromVector3(offset);
  return { theta: s.theta, phi: s.phi, radius: s.radius };
}

/**
 * 打一条 console：转了什么、现在角度是多少、允许的角度范围是多少。
 * DevTools 里展开对象能直接看到数值，也能一眼看出是不是撞到了边界。
 */
export function logViewAngles(camera, target, tag, extra = {}) {
  const { theta, phi } = viewAngles(camera, target);
  const payload = {
    '方位角 θ': deg(theta),
    '方位角可转范围': `${deg(VIEW_ANGLES.azimuthMin)} ~ ${deg(VIEW_ANGLES.azimuthMax)}`,
    '俯仰角 φ': deg(phi),
    '俯仰角可转范围': `${deg(VIEW_ANGLES.polarMin)} ~ ${deg(VIEW_ANGLES.polarMax)}`,
    '相机坐标': `${camera.position.x.toFixed(2)}, ${camera.position.y.toFixed(2)}, ${camera.position.z.toFixed(2)}`,
    '说明': 'θ=0° 正面 / 90° 右面；φ=0° 俯视 / 90° 平视',
    ...extra,
  };
  console.log(`[转视角] ${tag}`, payload);
  return payload;   // 方便在 DevTools 里 cubeView() 直接拿到数值
}

/**
 * 木块描边：和地面 GridHelper 一样是 WebGL 的 1px 线（不是纹理里贴出来的边），
 * 所以任意角度都是连续的一整条、粗细也和地面格子线一致。
 *
 * 之前"有的边显示、有的不显示"是因为线正好贴在面上、深度几乎相等，
 * 又给线加了 1.002 的放大（某些角度会绕到面后面去）。
 * 现在两件事一起解决：
 *   1. 面材质用 polygonOffset 往深度后方推一点点（只推面，不推线），线必定压在面上；
 *   2. 线不再放大、不写深度、renderOrder 提高，避免相邻方块的线互抢。
 * 于是每条边都稳定显示，且只有 1px。
 */
export const CUBE_FACE = Object.freeze({
  polygonOffset: true,
  polygonOffsetFactor: 2,
  polygonOffsetUnits: 2,
});

/** 所有木块共用一份 1px 黑色描边材质；renderOrder 由调用方设在 LineSegments 上 */
export function makeEdgeMaterial() {
  return new THREE.LineBasicMaterial({ color: 0x111111, depthWrite: false });
}

export const EDGE_RENDER_ORDER = 1;
