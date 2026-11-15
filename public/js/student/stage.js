/**
 * 学生端的 3D 舞台：摆放正方体（自由拖拽 + 吸附网格）与观测。
 *
 * 交互模型
 *   左键：拖方块 = 移动到新位置（吸附）
 *   方块库：按住拖进场景 = 放一块；点一下 = 进入"连续放置"，之后在场景里点哪放哪
 *   右键拖动 = 转视角，中键拖动 = 平移（不提供缩放：取景已经保证整个区域都看得见）
 *   **平板没有右键**：舞台右下角有一个视角球，按住它拖动就能转视角（点一下回到正面视角）
 *   Esc / 右键 = 退出放置；橡皮模式 = 点谁删谁
 *   键盘：舞台获得焦点后，方向键选格子、回车放一块、Delete 拿走那一列最上面一块
 *
 * 吸附规则：射线打到方块就落到"那个面外面那一列"的顶上，打到地面就落到那一格顶上。
 * 因此永远不会悬空、不会重叠、不会越界。
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { LIMITS, keyOf } from '../shared/model.js';
import { fitDistance } from './camera-fit.js';

const OFF_X = (LIMITS.sizeX - 1) / 2;
const OFF_Z = (LIMITS.sizeZ - 1) / 2;

/** 地面范围：x/z 各 ±2.5 —— 这部分永远要完整可见，否则会有"点不到"的格子 */
const GROUND_MIN = [-LIMITS.sizeX / 2, 0, -LIMITS.sizeZ / 2];
/** 取景高度下限：方块很矮时也别把画面缩成一粒芝麻 */
const MIN_FIT_TOP = 3.2;
/** "中心 -> 相机"的方向 */
// 默认视角：从"正面 + 右面"之间的 45° 方向看，仰角 45°（教材插图的透视感）
const HOME_DIR = new THREE.Vector3(0.5, Math.SQRT1_2, 0.5).normalize();

/** 格子坐标 -> 世界坐标（方块中心） */
export function toWorld(x, y, z, out = new THREE.Vector3()) {
  return out.set(x - OFF_X, y + 0.5, z - OFF_Z);
}

/** 地面平面上的世界坐标 -> 格子下标（含 0..4 判定） */
export function toCellXZ(v) {
  return {
    x: Math.floor(v.x + OFF_X + 0.5),
    z: Math.floor(v.z + OFF_Z + 0.5),
  };
}

export class CubeStage {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} handlers onPlace / onMove / onDelete / onPlacingChange / onKeyboardModeChange
   */
  constructor(canvas, handlers = {}) {
    this.canvas = canvas;
    this.handlers = handlers;

    this.cubes = [];
    this.occupied = new Set();
    this.selected = null;      // 点中的那一块（高亮；「移动」模式下点第二个格子就会把它挪过去）
    this.moveMode = false;     // 「移动」开关：点方块选中 → 点目标格子挪过去
    this.eraseMode = false;

    this.placing = false;
    this.placingSticky = false;
    this.armingDrag = false;
    this.armingStart = null;
    this.drag = null;      // { from, target, valid }
    this.pointerInside = false;
    this.lastClient = { x: 0, y: 0 };
    this.needsRender = true;

    this.userAdjusted = false;   // 用户自己转过视角后，不再自动改他的取景
    this.kbActive = false;       // 键盘光标是否已激活
    this.hoverKey = null;        // 橡皮模式下悬停的方块
    this.focusCell = null;       // 键盘光标所在的格子 {x, z}

    this._initThree();
    this._initGhost();
    this._bindEvents();
  }

  // ------------------------------------------------------------------ 初始化

  _initThree() {
    // alpha:true —— 让舞台背后的方格纸底纹透上来
    const renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer = renderer;

    const scene = new THREE.Scene();
    scene.background = null;
    this.scene = scene;

    const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 200);
    this.camera = camera;

    const controls = new OrbitControls(camera, this.canvas);
    controls.enableDamping = true;
    controls.dampingFactor = 0.12;
    controls.minDistance = 4.5;
    controls.maxDistance = 40;
    controls.enableZoom = false;          // 按要求不做滚轮缩放；取景已保证全部可见
    // 只允许：从默认 45° 仰角往上看到俯视（不钻到地面以下）
    controls.maxPolarAngle = Math.PI / 4;
    controls.minPolarAngle = 0;
    // 水平方向只允许在"正面 → 右面"这 90° 之间转
    controls.minAzimuthAngle = 0;
    controls.maxAzimuthAngle = Math.PI / 2;
    controls.enablePan = true;
    controls.mouseButtons = {
      LEFT: null,                    // 左键留给方块操作
      MIDDLE: THREE.MOUSE.PAN,
      RIGHT: THREE.MOUSE.ROTATE,
    };
    controls.touches = {
      ONE: null,                     // 单指留给方块操作
      TWO: THREE.TOUCH?.ROTATE,      // 双指只转视角，不缩放
    };
    this.controls = controls;
    // 用户一旦自己转过视角，就不在窗口变化时擅自改回去
    controls.addEventListener('start', () => { this.userAdjusted = true; });

    // 灯光：为看清"谁挡住谁"，用均匀柔和的光，不投影、不花哨
    scene.add(new THREE.HemisphereLight(0xfff6e8, 0xe8d3b4, 2.1));
    const key = new THREE.DirectionalLight(0xffffff, 2.0);
    key.position.set(6, 12, 8);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 0.9);
    fill.position.set(-9, 7, -7);
    scene.add(fill);

    // 地面 = 方格纸本体
    const base = new THREE.Mesh(
      new THREE.PlaneGeometry(LIMITS.sizeX, LIMITS.sizeZ),
      new THREE.MeshBasicMaterial({ color: 0xfffaf3 }),
    );
    base.rotation.x = -Math.PI / 2;
    base.position.y = 0;
    scene.add(base);

    const grid = new THREE.GridHelper(LIMITS.sizeX, LIMITS.sizeX, 0xdcc8a8, 0xeadbc4);
    grid.position.y = 0.004;
    scene.add(grid);

    this._addOrientationMarks(scene);

    const surround = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.PlaneGeometry(LIMITS.sizeX + 0.6, LIMITS.sizeZ + 0.6)),
      new THREE.LineBasicMaterial({ color: 0xe6d6bd }),
    );
    surround.rotation.x = -Math.PI / 2;
    surround.position.y = -0.004;
    scene.add(surround);

    // 共享几何与材质
    this.geo = new THREE.BoxGeometry(1, 1, 1);
    this.edgeGeo = new THREE.EdgesGeometry(this.geo);
    this.matCube = new THREE.MeshLambertMaterial({ color: 0xf7efa0 });     // 教材同款浅黄
    this.matHover = new THREE.MeshLambertMaterial({ color: 0xefe486 });
    this.matSelected = new THREE.MeshLambertMaterial({ color: 0xeec0d1 });  // 点中的积木：粉
    this.matEdge = new THREE.LineBasicMaterial({ color: 0x111111 });   // 细黑边

    this.cubeGroup = new THREE.Group();
    scene.add(this.cubeGroup);
    this.meshes = new Map(); // key -> mesh

    this._observeResize();
    this._fitCamera();
    this._loop();
  }

  /** 当前内容最高到第几层（没有方块时是 0） */
  _contentTop() {
    let top = 0;
    for (const [, y] of this.cubes) top = Math.max(top, y + 1);
    return top;
  }

  /**
   * 按"地面全宽 + 当前内容高度"取景。
   *
   * 为什么不是固定的 5×5×5：方块只有一两层时，固定取景会把画面缩得很小、
   * 屏幕上一大片空白；而只按内容取景又会让最高的格子跑出画面（点不到）。
   * 所以取 地面(5×5) × max(3.2, 当前高度+余量)：矮时画面饱满，叠高时自动后退。
   *
   * @param {boolean} animate 是否平滑过渡（放方块时用，避免相机"跳"一下）
   */
  _fitCamera({ animate = false } = {}) {
    const top = Math.max(MIN_FIT_TOP, this._contentTop() + 0.9);
    // 把视线中心压低一点点，画面整体就上移一点（地板更靠近垂直中线，下方留白多一些）
    const lift = top * 0.05;
    const center = new THREE.Vector3(0, top / 2 - lift, 0);
    const distance = fitDistance({
      fovDeg: this.camera.fov,
      aspect: this.camera.aspect,
      center: [center.x, center.y, center.z],
      dir: [HOME_DIR.x, HOME_DIR.y, HOME_DIR.z],
      min: GROUND_MIN,
      max: [LIMITS.sizeX / 2, top, LIMITS.sizeZ / 2],
    });

    const toPos = center.clone().addScaledVector(HOME_DIR, distance);
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

    if (!animate || reduced) {
      this.camera.position.copy(toPos);
      this.controls.target.copy(center);
      this.controls.update();
      this.needsRender = true;
      this._camTween = null;
      return;
    }

    this._camTween = {
      fromPos: this.camera.position.clone(),
      toPos,
      fromTarget: this.controls.target.clone(),
      toTarget: center,
      t0: performance.now(),
      dur: 260,
    };
  }

  _stepCamTween(now) {
    const tween = this._camTween;
    if (!tween) return false;
    const t = Math.min(1, (now - tween.t0) / tween.dur);
    const eased = 1 - Math.pow(1 - t, 3);
    this.camera.position.lerpVectors(tween.fromPos, tween.toPos, eased);
    this.controls.target.lerpVectors(tween.fromTarget, tween.toTarget, eased);
    this.controls.update();
    this.needsRender = true;
    if (t >= 1) this._camTween = null;
    return true;
  }

  /** 按屏幕像素位移转动视角（视角球、方向键共用） */
  orbitBy(dx, dy) {
    const offset = new THREE.Vector3().subVectors(this.camera.position, this.controls.target);
    const spherical = new THREE.Spherical().setFromVector3(offset);
    spherical.theta -= dx * 0.009;
    spherical.phi = Math.min(
      Math.PI / 2 - 0.08,
      Math.max(0.2, spherical.phi - dy * 0.009),
    );
    offset.setFromSpherical(spherical);
    this.camera.position.copy(this.controls.target).add(offset);
    this.camera.lookAt(this.controls.target);
    this.controls.update();
    this.userAdjusted = true;
    this.needsRender = true;
  }

  /** 回到默认取景（正视角） */
  resetView() {
    this.userAdjusted = false;
    this._fitCamera({ animate: true });
  }

  /**
   * 给"视角球"绑定手势：按住拖动 = 转视角；没拖动就松手 = 回正视角。
   * 平板上一根手指按在这里不会和"放方块"打架，因为球在画布外层、独立接收指针。
   */
  attachOrbitPad(padEl) {
    let dragging = null;

    padEl.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      padEl.setPointerCapture?.(event.pointerId);
      dragging = { x: event.clientX, y: event.clientY, moved: 0 };
      padEl.dataset.active = 'true';
    });

    padEl.addEventListener('pointermove', (event) => {
      if (!dragging) return;
      event.preventDefault();
      const dx = event.clientX - dragging.x;
      const dy = event.clientY - dragging.y;
      dragging.x = event.clientX;
      dragging.y = event.clientY;
      dragging.moved += Math.abs(dx) + Math.abs(dy);
      this.orbitBy(dx, dy);
    });

    // 只负责转视角：点一下不再回正（回正交给单独的「复位」按钮，避免学生误触）
    const finish = (event) => {
      if (!dragging) return;
      dragging = null;
      padEl.dataset.active = 'false';
      padEl.releasePointerCapture?.(event.pointerId);
    };

    padEl.addEventListener('pointerup', finish);
    padEl.addEventListener('pointercancel', finish);
    padEl.addEventListener('lostpointercapture', () => { dragging = null; padEl.dataset.active = 'false'; });
  }

  /** 地面的方位标记：正面（+z）与右面（+x）。转视角后学生要知道哪边是"正面"。 */
  _addOrientationMarks(scene) {
    const halfX = LIMITS.sizeX / 2;
    const halfZ = LIMITS.sizeZ / 2;

    const edge = (points, color) => {
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(points),
        new THREE.LineBasicMaterial({ color }),
      );
      scene.add(line);
    };

    // 正面（z = +halfZ，最靠近观察者的一条边）
    edge([
      new THREE.Vector3(-halfX, 0.014, halfZ),
      new THREE.Vector3(halfX, 0.014, halfZ),
    ], 0x8c5a2b);
    // 右面（x = +halfX）
    edge([
      new THREE.Vector3(halfX, 0.014, -halfZ),
      new THREE.Vector3(halfX, 0.014, halfZ),
    ], 0xb07a3c);

    const front = this._makeLabel('正面', '#8c5a2b');
    front.position.set(0, 0.22, halfZ + 0.62);
    scene.add(front);

    const right = this._makeLabel('右面', '#b07a3c');
    right.position.set(halfX + 0.62, 0.22, 0);
    scene.add(right);
  }

  _makeLabel(text, color) {
    const scale = 2;
    const canvas = document.createElement('canvas');
    canvas.width = 256 * scale;
    canvas.height = 64 * scale;
    const ctx = canvas.getContext('2d');
    ctx.scale(scale, scale);
    ctx.font = '600 30px -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = color;
    ctx.fillText(text, 128, 34);

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: texture, transparent: true, depthWrite: false,
    }));
    sprite.scale.set(1.7, 0.42, 1);
    return sprite;
  }

  _initGhost() {
    const geo = new THREE.BoxGeometry(0.98, 0.98, 0.98);
    this.ghostGroup = new THREE.Group();
    this.ghostMesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      color: 0x1c7a52, transparent: true, opacity: 0.42, depthWrite: false,
    }));
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(geo),
      new THREE.LineBasicMaterial({ color: 0x14532d, transparent: true, opacity: 0.8 }),
    );
    this.ghostGroup.add(this.ghostMesh, edges);
    this.ghostGroup.visible = false;
    this.scene.add(this.ghostGroup);
  }

  _observeResize() {
    const resize = () => {
      const parent = this.canvas.parentElement;
      const w = Math.max(1, parent.clientWidth);
      const h = Math.max(1, parent.clientHeight);
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      if (!this.userAdjusted) this._fitCamera();
      this.needsRender = true;
    };
    this._resize = resize;
    this._ro = new ResizeObserver(resize);
    this._ro.observe(this.canvas.parentElement);
    // ResizeObserver 在布局完成前的首次回调可能拿到 0 尺寸，这里补一次
    requestAnimationFrame(resize);
  }

  _loop = () => {
    this._raf = requestAnimationFrame(this._loop);
    const tweening = this._stepCamTween(performance.now());
    const damping = this.controls.update();
    if (tweening || damping || this.needsRender) {
      this.renderer.render(this.scene, this.camera);
      this.needsRender = false;
    }
  };

  // ------------------------------------------------------------------ 数据

  setCubes(cubes) {
    this.cubes = cubes.map((c) => [c[0], c[1], c[2]]);
    this.occupied = new Set(this.cubes.map((c) => keyOf(c[0], c[1], c[2])));

    // 几何与材质是共享的，这里只把网格从场景里摘掉，不做 dispose
    for (const mesh of this.meshes.values()) this.cubeGroup.remove(mesh);
    this.meshes.clear();

    for (const [x, y, z] of this.cubes) {
      const mesh = new THREE.Mesh(this.geo, this.matCube);
      toWorld(x, y, z, mesh.position);
      mesh.userData.cell = [x, y, z];
      const outline = new THREE.LineSegments(this.edgeGeo, this.matEdge);
      outline.scale.setScalar(1.002);   // 稍微外扩，避免和面共面产生断断续续的线
      mesh.add(outline);
      this.cubeGroup.add(mesh);
      this.meshes.set(keyOf(x, y, z), mesh);
    }

    if (this.hoverKey && !this.occupied.has(this.hoverKey)) this.hoverKey = null;
    if (this.selected && !this.occupied.has(keyOf(...this.selected))) {
      this.selected = null;
      this.canvas.dataset.selected = '';
    }
    this._paintCubes();
    this.needsRender = true;

    // 叠高到一定程度时把相机往后拉一点（只改距离，不改用户自己转的角度）
    const top = this._contentTop();
    if (top !== this._lastTop) {
      this._lastTop = top;
      if (!this.userAdjusted) this._fitCamera({ animate: true });
    }
    if (this.kbActive) this._updateCursor();
  }

  _paintCubes() {
    const selKey = this.selected ? keyOf(...this.selected) : null;
    for (const [k, mesh] of this.meshes) {
      if (k === selKey) mesh.material = this.matSelected;
      else if (k === this.hoverKey) mesh.material = this.matHover;
      else mesh.material = this.matCube;
    }
  }

  /** 选中某一块（null = 取消选中）。只改颜色，不改数据。 */
  setSelected(cell) {
    const next = cell ? [cell[0], cell[1], cell[2]] : null;
    const same = (a, b) => (a === null && b === null) || (a && b && a[0] === b[0] && a[1] === b[1] && a[2] === b[2]);
    if (same(next, this.selected)) return;
    this.selected = next;
    this.canvas.dataset.selected = next ? keyOf(...next) : '';
    if (!next) this._hideGhost();
    this._paintCubes();
    this.needsRender = true;
  }

  _setHover(key) {
    if (this.hoverKey === key) return;
    this.hoverKey = key;
    this._paintCubes();
    this.needsRender = true;
  }

  /** 「移动」开关：开启后，选中一块再点别的格子就能把它挪过去（平板友好） */
  setMoveMode(on) {
    this.moveMode = !!on;
    this.canvas.style.cursor = this.moveMode ? 'grab' : '';
    if (!this.moveMode) {
      this.setSelected(null);
      this._hideGhost();
    }
    this.needsRender = true;
  }

  setEraseMode(on) {
    this.eraseMode = !!on;
    if (this.eraseMode) this.endPlacing();
    this.canvas.style.cursor = this.eraseMode ? 'crosshair' : '';
    if (!this.eraseMode) this._setHover(null);
    this.needsRender = true;
  }

  // ------------------------------------------------------------------ 放置

  _columnHeight(x, z, excludeKey = null) {
    let h = 0;
    while (h < LIMITS.sizeY) {
      const k = keyOf(x, h, z);
      if (!this.occupied.has(k) || k === excludeKey) break;
      h++;
    }
    return h;
  }

  /** 把 (x,z) 这一列"落到顶"：返回 { legal, x, y, z, reason } */
  _settle(x, z, excludeKey = null) {
    if (x < 0 || x >= LIMITS.sizeX || z < 0 || z >= LIMITS.sizeZ) {
      return { legal: false, x, y: 0, z, reason: 'outside' };
    }
    const y = this._columnHeight(x, z, excludeKey);
    if (y >= LIMITS.sizeY) return { legal: false, x, y: LIMITS.sizeY - 1, z, reason: 'full' };
    return { legal: true, x, y, z, reason: 'ok' };
  }

  /** 指针落在地面的哪个格子（不看方块），越界返回 null */
  _groundCell(clientX, clientY) {
    const raycaster = this._raycaster();
    raycaster.setFromCamera(this._ndc(clientX, clientY), this.camera);
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const point = new THREE.Vector3();
    if (!raycaster.ray.intersectPlane(plane, point)) return null;
    const { x, z } = toCellXZ(point);
    if (x < 0 || x >= LIMITS.sizeX || z < 0 || z >= LIMITS.sizeZ) return null;
    return { x, z };
  }

  _raycaster() {
    if (!this._rc) this._rc = new THREE.Raycaster();
    return this._rc;
  }

  _ndc(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    return new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
  }

  /** 计算当前指针位置对应的吸附目标 */
  _targetAt(clientX, clientY, excludeKey = null) {
    const raycaster = this._raycaster();
    raycaster.setFromCamera(this._ndc(clientX, clientY), this.camera);

    const meshes = [...this.meshes.entries()]
      .filter(([k]) => k !== excludeKey)
      .map(([, mesh]) => mesh);

    const hits = raycaster.intersectObjects(meshes, false);
    if (hits.length) {
      // 落在任意方块上（不管是顶面还是侧面）都理解为"放到这一列的最上面"。
      // 小学生点一个方块时想的是"叠在它上面"，而不是"在它旁边那一格"。
      const [cx, , cz] = hits[0].object.userData.cell;
      return this._settle(cx, cz, excludeKey);
    }

    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const point = new THREE.Vector3();
    if (!raycaster.ray.intersectPlane(plane, point)) return null;
    const { x, z } = toCellXZ(point);
    return this._settle(x, z, excludeKey);
  }

  _showGhost(target, mode) {
    if (!target || target.reason === 'outside') {
      this.ghostGroup.visible = false;
      return;
    }
    toWorld(target.x, target.y, target.z, this.ghostGroup.position);
    const legal = target.legal;
    if (mode === 'cursor') {
      this.ghostMesh.material.color.setHex(legal ? 0xf59bbb : 0xb3402a);
      this.ghostMesh.material.opacity = legal ? 0.34 : 0.28;
    } else {
      this.ghostMesh.material.color.setHex(legal ? 0xf59bbb : 0xb3402a);
      this.ghostMesh.material.opacity = legal ? 0.4 : 0.3;
    }
    this.ghostGroup.visible = true;
    this.needsRender = true;
  }

  _hideGhost() {
    if (this.ghostGroup.visible) {
      this.ghostGroup.visible = false;
      this.needsRender = true;
    }
  }

  beginPlacing({ sticky = true, clientX = null, clientY = null } = {}) {
    if (this.eraseMode) this.setEraseMode(false);
    this.placing = true;
    this.placingSticky = sticky;
    // armingDrag 只表示"这一次从方块库按下去的拖拽手势还没结束"。
    // 它结束后，后续在场景里的单击就是单纯的一次单击（否则鼠标先移动过
    // 就会被误判成拖拽，一次点击会放下两块）。
    this.armingDrag = clientX != null;
    this.armingStart = clientX == null ? null : { x: clientX, y: clientY, moved: false };
    window.addEventListener('pointermove', this._onWindowMove);
    window.addEventListener('pointerup', this._onWindowUp);
    this.handlers.onPlacingChange?.(true);
    if (clientX != null) this._updateGhostFromPointer(clientX, clientY);
  }

  endPlacing() {
    if (!this.placing) return;
    this.placing = false;
    this.armingDrag = false;
    this.armingStart = null;
    window.removeEventListener('pointermove', this._onWindowMove);
    window.removeEventListener('pointerup', this._onWindowUp);
    this._hideGhost();
    this.handlers.onPlacingChange?.(false);
  }

  _pointerOverCanvas(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    return clientX >= rect.left && clientX <= rect.right
        && clientY >= rect.top && clientY <= rect.bottom;
  }

  _updateGhostFromPointer(clientX, clientY, excludeKey = null) {
    if (!this._pointerOverCanvas(clientX, clientY)) {
      this.pointerInside = false;
      this._hideGhost();
      return null;
    }
    this.pointerInside = true;
    const target = this._targetAt(clientX, clientY, excludeKey);
    this._showGhost(target, 'place');
    return target;
  }

  _onWindowMove = (event) => {
    // 橡皮模式：高亮"这一下会删掉哪一块"，避免误删
    if (this.eraseMode && !this.drag && !this.placing) {
      const raycaster = this._raycaster();
      raycaster.setFromCamera(this._ndc(event.clientX, event.clientY), this.camera);
      const hit = raycaster.intersectObjects([...this.meshes.values()], false)[0];
      this._setHover(hit ? keyOf(...hit.object.userData.cell) : null);
      return;
    }
    if (this.drag) {
      const excludeKey = keyOf(...this.drag.from);
      const dx = event.clientX - (this.drag.startX ?? event.clientX);
      const dy = event.clientY - (this.drag.startY ?? event.clientY);
      this.drag.moved = Math.max(this.drag.moved ?? 0, Math.hypot(dx, dy));
      const target = this._updateGhostFromPointer(event.clientX, event.clientY, excludeKey);
      this.drag.target = target;
      this.drag.valid = !!target?.legal;
      return;
    }
    if (this.placing) {
      if (this.armingDrag && this.armingStart && !this.armingStart.moved) {
        const dx = event.clientX - this.armingStart.x;
        const dy = event.clientY - this.armingStart.y;
        if (Math.hypot(dx, dy) > 6) this.armingStart.moved = true;
      }
      this._updateGhostFromPointer(event.clientX, event.clientY);
    }
  };

  _onWindowUp = (event) => {
    if (event.button !== undefined && event.button !== 0) return;

    if (this.drag) {
      const { from, target, valid, tapSelf, moved } = this.drag;
      this.drag = null;
      this._restoreDragged();
      this._hideGhost();
      this._releaseWindowListeners();

      // 轻点自己（没拖动）＝ 取消选中
      if (tapSelf && (moved ?? 0) < 8) {
        this.setSelected(null);
        return;
      }
      if (valid && target && (target.x !== from[0] || target.y !== from[1] || target.z !== from[2])) {
        this.handlers.onMove?.(from, [target.x, target.y, target.z]);
      }
      return;
    }

    // 只有"从方块库按下去的这一次手势"在这里收尾；场景里的单击不归它管
    if (this.placing && this.armingDrag) {
      const wasDrag = this.armingStart?.moved;
      const target = this._updateGhostFromPointer(event.clientX, event.clientY);
      this.armingDrag = false;
      this.armingStart = null;
      if (wasDrag) {
        if (target?.legal) this.handlers.onPlace?.([target.x, target.y, target.z]);
        this.endPlacing();
      }
    }
  };

  _restoreDragged() {
    this._draggedMesh = null;
  }

  /** 拖动结束后把 window 上的临时监听摘掉（放置模式自己会再挂上） */
  _releaseWindowListeners() {
    if (this.placing) return;
    window.removeEventListener('pointermove', this._onWindowMove);
    window.removeEventListener('pointerup', this._onWindowUp);
  }

  // ------------------------------------------------------------------ 键盘

  /**
   * 键盘路径：舞台获得焦点后，方向键选格子、回车放一块、Delete 拿走那一列最上面一块。
   * 只在真正按了方向键之后才显示蓝色光标，免得鼠标点一下也冒出光标。
   */
  _onCanvasFocus = () => {
    if (!this.focusCell) this.focusCell = { x: 0, z: 0 };
  };

  _onCanvasBlur = () => {
    this.focusCell = null;
    this._setKeyboardMode(false);
    if (!this.placing && !this.drag) this._hideGhost();
  };

  _setKeyboardMode(on) {
    if (this.kbActive === on) return;
    this.kbActive = on;
    this.handlers.onKeyboardModeChange?.(on);
    if (!on && !this.placing && !this.drag) this._hideGhost();
  }

  _updateCursor() {
    if (!this.kbActive || !this.focusCell || this.placing || this.drag) return;
    this._showGhost(this._settle(this.focusCell.x, this.focusCell.z), 'cursor');
  }

  /** 悬停预览：移动模式下选中一块后，指针移到哪，就在那显示一个半透明落点方块 */
  _onCanvasHover = (event) => {
    if (!this.moveMode || !this.selected || this.drag || this.placing) return;
    if (!this._pointerOverCanvas(event.clientX, event.clientY)) return;

    const target = this._targetAt(event.clientX, event.clientY, keyOf(...this.selected));
    const same =
      target &&
      this.selected[0] === target.x &&
      this.selected[1] === target.y &&
      this.selected[2] === target.z;

    if (!target || same) {
      this._hideGhost();
      return;
    }
    this._showGhost(target, 'place');
  };

  _onCanvasLeave = () => {
    if (!this.drag && !this.placing) this._hideGhost();
  };

  _onCanvasKeydown = (event) => {
    if (!this.focusCell) this.focusCell = { x: 0, z: 0 };
    const { x, z } = this.focusCell;

    const step = {
      ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1],
    }[event.key];

    if (step) {
      event.preventDefault();
      this._setKeyboardMode(true);
      this.focusCell = {
        x: Math.min(LIMITS.sizeX - 1, Math.max(0, x + step[0])),
        z: Math.min(LIMITS.sizeZ - 1, Math.max(0, z + step[1])),
      };
      this._updateCursor();
      return;
    }

    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      this._setKeyboardMode(true);

      // 添上模式：在光标格子放一块
      if (this.placing) {
        const target = this._settle(x, z);
        if (target.legal) this.handlers.onPlace?.([target.x, target.y, target.z]);
        this._updateCursor();
        return;
      }

      // 移动模式：把选中的方块挪到光标格子
      if (this.selected) {
        const from = this.selected;
        const target = this._settle(x, z, keyOf(...from));
        if (target.legal && (target.x !== from[0] || target.y !== from[1] || target.z !== from[2])) {
          this.handlers.onMove?.(from, [target.x, target.y, target.z]);
        }
      }
      this._updateCursor();
      return;
    }

    // 拿走模式：Delete / Backspace = 移走光标所在列最上面一块
    if ((event.key === 'Delete' || event.key === 'Backspace') && this.eraseMode) {
      const height = this._columnHeight(x, z);
      if (height > 0) {
        event.preventDefault();
        this.handlers.onDelete?.([x, height - 1, z]);
      }
    }
  };

  // ------------------------------------------------------------------ 事件

  _bindEvents() {
    const canvas = this.canvas;

    canvas.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      this.endPlacing();
    });

    canvas.addEventListener('pointermove', this._onCanvasHover);
    canvas.addEventListener('pointerleave', this._onCanvasLeave);
    canvas.addEventListener('focus', this._onCanvasFocus);
    canvas.addEventListener('blur', this._onCanvasBlur);
    canvas.addEventListener('keydown', this._onCanvasKeydown);

    canvas.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      this.lastClient = { x: event.clientX, y: event.clientY };
      this._setKeyboardMode(false);

      if (this.placing) {
        const target = this._targetAt(event.clientX, event.clientY);
        if (target?.legal) this.handlers.onPlace?.([target.x, target.y, target.z]);
        return;
      }

      const raycaster = this._raycaster();
      raycaster.setFromCamera(this._ndc(event.clientX, event.clientY), this.camera);
      const hits = raycaster.intersectObjects([...this.meshes.values()], false);

      // 移动模式：已有选中的方块 → 整个手势都是"拖动这块方块"
      // 按下就显示落点（空心虚线框），拖动时跟着走，松手才真正落下。
      // 只是轻点一下（没拖动）时：点在它自己身上 = 取消选中；点在别处 = 挪到那里。
      if (this.moveMode && this.selected) {
        const from = this.selected.slice();
        const fromKey = keyOf(...from);
        const tapSelf = hits.some((h) => keyOf(...h.object.userData.cell) === fromKey);

        this.drag = {
          from,
          target: null,
          valid: false,
          tapSelf,
          startX: event.clientX,
          startY: event.clientY,
          moved: 0,
        };
        this._draggedMesh = null;   // 选中的方块保持橙色，不隐藏
        window.addEventListener('pointermove', this._onWindowMove);
        window.addEventListener('pointerup', this._onWindowUp);

        if (tapSelf) {
          // 只是按住"自己"：先不显示落点；一拖出去就会出现在新位置
          this._hideGhost();
        } else {
          const target = this._updateGhostFromPointer(event.clientX, event.clientY, fromKey);
          this.drag.target = target;
          this.drag.valid = !!target?.legal;
        }
        return;
      }

      if (!hits.length) {
        this.setSelected(null);
        return;
      }

      const cell = hits[0].object.userData.cell;

      if (this.eraseMode) {
        this.setSelected(null);
        this.handlers.onDelete?.([cell[0], cell[1], cell[2]]);
        return;
      }

      this.setSelected(cell);        // 点中哪块，哪块变橙

      // 开始拖动：原方块保持可见（如果把它藏起来，压在上面的方块会看起来悬空），
      // 半透明的幽灵方块负责显示"会落到哪里"
      this.drag = {
        from: [cell[0], cell[1], cell[2]],
        target: null,
        valid: false,
      };
      this._draggedMesh = hits[0].object;
      window.addEventListener('pointermove', this._onWindowMove);
      window.addEventListener('pointerup', this._onWindowUp);
      this._updateGhostFromPointer(event.clientX, event.clientY, keyOf(...cell));
    });
  }

  dispose() {
    cancelAnimationFrame(this._raf);
    this._ro?.disconnect();
    window.removeEventListener('pointermove', this._onWindowMove);
    window.removeEventListener('pointerup', this._onWindowUp);
    this.controls.dispose();
    this.renderer.dispose();
  }
}
