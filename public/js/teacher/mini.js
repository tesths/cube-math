/**
 * 教师端的只读 3D 视图。
 *
 * 两种用法：
 *   new MiniStage(canvas)                    —— 8 宫格里的小卡片：固定等轴测视角，只渲染一帧
 *   new MiniStage(canvas, { interactive: true }) —— 放大演示：可以用视角球/鼠标右键转视角
 *
 * 几何与材质在所有实例之间共享，8 个卡片也只占很少显存。
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { LIMITS } from '../shared/model.js';
import { fitDistance } from '../student/camera-fit.js';

const OFF_X = (LIMITS.sizeX - 1) / 2;
const OFF_Z = (LIMITS.sizeZ - 1) / 2;

const geo = new THREE.BoxGeometry(1, 1, 1);
const edgeGeo = new THREE.EdgesGeometry(geo);
const matCube = new THREE.MeshLambertMaterial({ color: 0xf7efa0 });
const matEdge = new THREE.LineBasicMaterial({ color: 0x111111 });
const baseGeo = new THREE.PlaneGeometry(LIMITS.sizeX, LIMITS.sizeZ);
const baseMat = new THREE.MeshBasicMaterial({ color: 0xfffaf3 });

const GROUND_MIN = [-LIMITS.sizeX / 2, 0, -LIMITS.sizeZ / 2];
const MIN_FIT_TOP = 3.2;
const HOME_DIR = new THREE.Vector3(0.5, Math.SQRT1_2, 0.5).normalize();

export class MiniStage {
  constructor(canvas, { interactive = false, pad = null } = {}) {
    this.canvas = canvas;
    this.interactive = interactive;

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer = renderer;

    const scene = new THREE.Scene();
    scene.background = null;
    this.scene = scene;

    const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
    this.camera = camera;

    scene.add(new THREE.HemisphereLight(0xfff6e8, 0xe8d3b4, 2.1));
    const key = new THREE.DirectionalLight(0xffffff, 2.0);
    key.position.set(6, 12, 8);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 0.9);
    fill.position.set(-9, 7, -7);
    scene.add(fill);

    const base = new THREE.Mesh(baseGeo, baseMat);
    base.rotation.x = -Math.PI / 2;
    scene.add(base);

    const grid = new THREE.GridHelper(LIMITS.sizeX, LIMITS.sizeX, 0xdcc8a8, 0xeadbc4);
    grid.position.y = 0.004;
    scene.add(grid);

    this._addOrientationMarks(scene);

    this.group = new THREE.Group();
    scene.add(this.group);

    this.cubes = [];
    this.needsRender = true;

    if (interactive) {
      const controls = new OrbitControls(camera, canvas);
      controls.enableDamping = true;
      controls.dampingFactor = 0.12;
      controls.enableZoom = false;      // 与学生端一致：不做缩放，靠取景保证全都看得见
      controls.enablePan = false;
      controls.maxPolarAngle = Math.PI / 4;
      controls.minPolarAngle = 0;
      controls.minAzimuthAngle = 0;
      controls.maxAzimuthAngle = Math.PI / 2;
      controls.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE };
      controls.touches = { ONE: null, TWO: THREE.TOUCH?.ROTATE };
      this.controls = controls;
      controls.addEventListener('start', () => { this.userAdjusted = true; });
      if (pad) this.attachOrbitPad(pad);
      // 不在这里启动循环：等放大层真正打开时由 setActive(true) 启动
    }
  }

  _addOrientationMarks(scene) {
    const halfX = LIMITS.sizeX / 2;
    const halfZ = LIMITS.sizeZ / 2;
    const line = (points, color) => {
      scene.add(new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(points),
        new THREE.LineBasicMaterial({ color }),
      ));
    };
    line([new THREE.Vector3(-halfX, 0.014, halfZ), new THREE.Vector3(halfX, 0.014, halfZ)], 0x8c5a2b);
    line([new THREE.Vector3(halfX, 0.014, -halfZ), new THREE.Vector3(halfX, 0.014, halfZ)], 0xb07a3c);

    const front = this._label('正面', '#8c5a2b');
    front.position.set(0, 0.22, halfZ + 0.62);
    scene.add(front);
    const right = this._label('右面', '#b07a3c');
    right.position.set(halfX + 0.62, 0.22, 0);
    scene.add(right);
  }

  _label(text, color) {
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
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false }));
    sprite.scale.set(1.7, 0.42, 1);
    return sprite;
  }

  _contentTop() {
    let top = 0;
    for (const [, y] of this.cubes) top = Math.max(top, y + 1);
    return top;
  }

  /** 与学生端同一套取景规则：地面全宽 × max(3.2, 内容高度+余量) */
  _fit() {
    const top = Math.max(MIN_FIT_TOP, this._contentTop() + 0.9);
    const lift = top * 0.05;   // 与学生端一致：画面整体上移一点
    const center = new THREE.Vector3(0, top / 2 - lift, 0);
    const distance = fitDistance({
      fovDeg: this.camera.fov,
      aspect: this.camera.aspect,
      center: [center.x, center.y, center.z],
      dir: [HOME_DIR.x, HOME_DIR.y, HOME_DIR.z],
      min: GROUND_MIN,
      max: [LIMITS.sizeX / 2, top, LIMITS.sizeZ / 2],
    });
    this.camera.position.copy(center).addScaledVector(HOME_DIR, distance);
    this.controls.target.copy(center);
    this.controls.update();
    this.needsRender = true;
  }

  orbitBy(dx, dy) {
    const offset = new THREE.Vector3().subVectors(this.camera.position, this.controls.target);
    const spherical = new THREE.Spherical().setFromVector3(offset);
    spherical.theta -= dx * 0.009;
    spherical.phi = Math.min(Math.PI / 2 - 0.08, Math.max(0.2, spherical.phi - dy * 0.009));
    offset.setFromSpherical(spherical);
    this.camera.position.copy(this.controls.target).add(offset);
    this.camera.lookAt(this.controls.target);
    this.controls.update();
    this.userAdjusted = true;
    this.needsRender = true;
  }

  resetView() {
    this.userAdjusted = false;
    if (this.interactive) this._fit();
  }

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
    const finish = (event) => {
      if (!dragging) return;
      dragging = null;
      padEl.dataset.active = 'false';
      padEl.releasePointerCapture?.(event.pointerId);
    };
    padEl.addEventListener('pointerup', finish);
    padEl.addEventListener('pointercancel', finish);
  }

  /** 放大层打开/关闭时调用：关掉就别再跑 60fps 循环 */
  setActive(on) {
    if (!this.interactive) return;
    if (on && !this._raf) {
      this.needsRender = true;
      this._loop();
    } else if (!on && this._raf) {
      cancelAnimationFrame(this._raf);
      this._raf = null;
    }
  }

  _loop = () => {
    this._raf = requestAnimationFrame(this._loop);
    const damping = this.controls?.update?.();
    if (damping || this.needsRender) {
      this.renderer.render(this.scene, this.camera);
      this.needsRender = false;
    }
  };

  setCubes(cubes) {
    this.cubes = cubes;
    this.group.clear();
    for (const [x, y, z] of cubes) {
      const mesh = new THREE.Mesh(geo, matCube);
      mesh.position.set(x - OFF_X, y + 0.5, z - OFF_Z);
      const outline = new THREE.LineSegments(edgeGeo, matEdge);
      outline.scale.setScalar(1.002);
      mesh.add(outline);
      this.group.add(mesh);
    }
    this.needsRender = true;
    if (this.interactive) {
      const top = this._contentTop();
      if (top !== this._lastTop) {
        this._lastTop = top;
        if (!this.userAdjusted) this._fit();
      }
    } else {
      this.render();
    }
  }

  resize() {
    const parent = this.canvas.parentElement;
    const w = Math.max(1, parent.clientWidth);
    const h = Math.max(1, parent.clientHeight);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (this.interactive) {
      if (!this.userAdjusted) this._fit();
    } else {
      this._placeStatic();
    }
    this.needsRender = true;
    if (!this.interactive) this.render();
  }

  /** 小卡片：固定等轴测视角，按占地大小不变（8 格同屏可比） */
  _placeStatic() {
    const distance = 11.2;
    this.camera.position.copy(new THREE.Vector3(6.6, 6.9, 8.4)).normalize().multiplyScalar(distance)
      .add(new THREE.Vector3(0, 1.05, 0));
    this.camera.lookAt(new THREE.Vector3(0, 1.05, 0));
  }

  render() {
    if (!this.needsRender) return;
    this.renderer.render(this.scene, this.camera);
    this.needsRender = false;
  }

  dispose() {
    cancelAnimationFrame(this._raf);
    this.controls?.dispose();
    this.renderer.dispose();
  }
}
