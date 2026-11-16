/**
 * 学生端主程序：首页认领自己的组 → 摆放 → 看三视图 → 自动保存。
 *
 * 认领之后这台设备就固定在这一组（没有"换组"入口），避免学生误点别的组、
 * 把别人的作品覆盖掉。老师要给某台机器换组，用 `/?reset` 打开一次即可。
 */
import { CubeStage } from './stage.js';
import { ViewPanel } from './views.js';
import { sanitizeLoose, collapseColumns, taskInitial, taskMeta, normalizeTask } from '../shared/model.js';
import { openStateStream, saveGroup, saveGroupBeacon, fetchState, fetchSettings } from '../shared/net.js';

const GROUP_COUNT = 8;
const LS_KEY = 'cube-views:group';
const LS_MODE = 'cube-views:mode';        // 'training'(只显示任务0) | 'formal'(任务1·2·3)
const LS_TASK0 = 'cube-views:task0';      // 任务0（练习）的本地进度，不写服务器
const SAVE_DEBOUNCE = 350;
const ADOPT_REMOTE_AFTER = 1200;   // 自己刚改完的这段时间内忽略服务器回声，免得和手速打架

const $ = (id) => document.getElementById(id);

const els = {
  gate: $('gate'),
  groupGrid: $('groupGrid'),
  groupLabel: $('groupLabel'),
  status: $('status'),
  statusText: $('statusText'),
  toolModes: $('toolModes'),
  toolButtons: [...document.querySelectorAll('.tool-mode-btn')],
  toolStep: $('toolStep'),
  resetBtn: $('resetBtn'),
  taskTabs: $('taskTabs'),
  toolTip: $('toolTip'),
  stage: $('stage'),
  scene: $('scene'),
  cubeCount: $('cubeCount'),
  placingHint: $('placingHint'),
  guideChip: $('guideChip'),
  guideToast: $('guideToast'),
  kbHint: $('kbHint'),
  showViews: $('showViews'),
  orbitPad: $('orbitPad'),
  resetView: $('resetView'),
  viewsGrid: $('viewsGrid'),
  viewPlaceholder: $('viewPlaceholder'),
  viewFoot: $('viewFoot'),
};

const app = {
  group: null,
  bound: false,
  cubes: [],
  serverGroups: new Map(),
  stage: null,
  panel: null,
  stream: null,
  saveTimer: null,
  retryTimer: null,
  saving: false,
  dirty: false,
  retries: 0,
  lastEditAt: 0,
  viewMode: 'formal',    // 'formal' | 'training'（设置页切换）
  task: 1,               // 0=练习（本地） 1=移动 2=拿走 3=添上
  tasks: {},             // 任务1/2/3 各自的进度（切任务不丢）
  mode: 'none',          // 'none' | 'move' | 'erase' | 'place'
};

const TOOL_TIPS = {
  zero: '任务0：先点一个工具按钮（移动 / 拿走 / 添上），再操作木块。三个都试一试，熟悉一下平板。「重置木块」回到最初的样子。',
  move: '先点「移动木块」按钮，才能点木块；点中一块再点目标格子就能挪过去，也可以直接拖动。移好后点一下「移动木块」结束。「重置木块」回到这个任务最初的样子。',
  erase: '先点「拿走木块」按钮，才能点木块；点任意木块就把它拿走，上面的木块会自动落下。「重置木块」回到这个任务最初的样子。',
  place: '先点「添上木块」按钮，才能加木块；点木块顶面或空格子就能添一块，再点一次按钮或按 Esc 结束。「重置木块」回到这个任务最初的样子。',
};

/** 两步引导：没点亮工具时提示「先点按钮」，点亮后提示「现在怎么操作」 */
const GUIDES = {
  zero:  { idle: '① 先点一个工具按钮（移动 / 拿走 / 添上）', active: '② 现在去舞台里操作木块（再点按钮可换工具）' },
  move:  { idle: '① 先点左边「移动木块」按钮',   active: '② 点中一块 → 点目标格子；移好后点「移动木块」结束' },
  erase: { idle: '① 先点左边「拿走木块」按钮',   active: '② 点任意木块，就把它拿走' },
  place: { idle: '① 先点「添上木块」按钮',       active: '② 点木块顶面或空格子，就能添一块' },
};

let guideTimer = null;

const KB_TIPS = {
  zero: '方向键选格子 · 按当前工具操作',
  move: '方向键选格子 · 回车把选中的木块挪过去',
  erase: '方向键选格子 · Delete 拿走那一列最上面一块',
  place: '方向键选格子 · 回车添一块',
};

/** 当前任务对应的工具栏/引导 key（任务0 用 zero） */
function guideKey() {
  return app.task === 0 ? 'zero' : taskMeta(app.task).action;
}

// ------------------------------------------------------------------ 工具

const key = (c) => `${c[0]},${c[1]},${c[2]}`;

/** 深拷贝"三个任务的进度" */
function cloneTasks(tasks) {
  const out = { 1: [], 2: [], 3: [] };
  for (const k of [1, 2, 3]) out[k] = (tasks?.[k] ?? taskInitial(k)).map((c) => [...c]);
  return out;
}

/**
 * localStorage 在隐私模式/被禁用时会直接抛异常。
 * 锁定逻辑不能因此把页面弄崩：读不到就当作"没绑定"，写不进去就只在本页会话内锁定。
 */
function readBound() {
  try {
    const n = Number(localStorage.getItem(LS_KEY));
    return Number.isInteger(n) && n >= 1 && n <= GROUP_COUNT ? n : null;
  } catch {
    return null;
  }
}

function writeBound(n) {
  try {
    localStorage.setItem(LS_KEY, String(n));
  } catch {
    /* 存不了就算了，本次会话仍然是锁定的 */
  }
}

function clearBound() {
  try {
    localStorage.removeItem(LS_KEY);
  } catch {
    /* 同上 */
  }
}

/** 设置页选择的模式；默认 formal（保持原有行为） */
function readViewMode() {
  try {
    return localStorage.getItem(LS_MODE) === 'training' ? 'training' : 'formal';
  } catch {
    return 'formal';
  }
}

function writeViewMode(mode) {
  try {
    localStorage.setItem(LS_MODE, mode === 'training' ? 'training' : 'formal');
  } catch { /* 存不了就算，本次会话仍按服务器设置 */ }
}

/**
 * 决定显示模式：**优先服务器全局设置**（教师在自己电脑上设置的），
 * 失败（离线/无后端）再退回本机 localStorage。
 * 这是关键：教师电脑和学生平板是两台设备，只有服务器能让设置“传过去”。
 */
async function resolveViewMode() {
  try {
    const s = await fetchSettings();
    if (s?.mode === 'training' || s?.mode === 'formal') {
      writeViewMode(s.mode);
      return s.mode;
    }
  } catch { /* 退回本机 */ }
  return readViewMode();
}

/** 任务0（练习）的本地进度；坏了就回初始图形 */
function readTask0() {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_TASK0) || 'null');
    if (Array.isArray(raw) && raw.length) return pipeline(raw);
  } catch { /* 忽略坏数据 */ }
  return taskInitial(0);
}

function saveTask0(cubes) {
  try {
    localStorage.setItem(LS_TASK0, JSON.stringify(cubes));
  } catch { /* 存不了就算，本次会话仍可练 */ }
}

function sameCubes(a, b) {
  if (a.length !== b.length) return false;
  const setB = new Set(b.map(key));
  return a.every((c) => setB.has(key(c)));
}

function setStatus(state, text) {
  els.status.dataset.state = state;
  els.statusText.textContent = text;
}

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false });
}

/** 没先点工具按钮就点木块 / 按键盘：弹一条提醒，并把工具按钮再闪一下 */
function showGuideReminder(message) {
  const fallback = app.task === 0
    ? '先点一个工具按钮（移动 / 拿走 / 添上），再操作木块'
    : `先点左边的「${taskMeta(app.task).actionLabel}」按钮，再操作木块`;
  els.guideToast.textContent = message ?? fallback;
  els.guideToast.hidden = false;

  for (const btn of visibleToolButtons()) {
    btn.classList.remove('nudge');
    void btn.offsetWidth;      // 强制重排，让动画每次都能重新播放
    btn.classList.add('nudge');
  }
  clearTimeout(guideTimer);
  guideTimer = setTimeout(hideGuideReminder, 2600);
}

function hideGuideReminder() {
  clearTimeout(guideTimer);
  guideTimer = null;
  els.guideToast.hidden = true;
  for (const btn of els.toolButtons) btn.classList.remove('nudge');
}

/** 当前任务下显示哪些工具按钮 */
function visibleToolButtons() {
  return els.toolButtons.filter((btn) => !btn.hidden);
}

/**
 * 唯一的交互清洗管线：宽松去重/去越界 -> 重力塌落。
 * 顺序不能反：先按"悬空"严格过滤会把上层方块整批丢掉（拿掉柱子底层 -> 整列消失）。
 * 服务器侧仍用严格校验（validateCubes），两边语义各司其职。
 */
function pipeline(cubes) {
  return collapseColumns(sanitizeLoose(cubes).cubes);
}

// ------------------------------------------------------------------ 选组

function renderGate() {
  els.groupGrid.replaceChildren();
  for (let i = 1; i <= GROUP_COUNT; i++) {
    const info = app.serverGroups.get(i);
    const active = normalizeTask(info?.task);
    const n = info?.tasks?.[active]?.length ?? 0;

    const btn = document.createElement('button');
    btn.type = 'button';
    const num = document.createElement('span');
    num.className = 'n';
    num.textContent = String(i);
    const label = document.createElement('span');
    label.className = 't';
    label.textContent = `第 ${i} 组`;
    btn.append(num, label);
    if (n > 0) {
      const taken = document.createElement('span');
      taken.className = 'taken';
      taken.textContent = `已有 ${n} 块`;
      btn.append(taken);
    }
    btn.addEventListener('click', () => enterGroup(i));
    els.groupGrid.append(btn);
  }

}

/** 把地址栏里的组号同步成当前组：老师改 URL 就能改组，学生界面里没有入口 */
function syncUrl(n) {
  const params = new URLSearchParams(location.search);
  params.delete('reset');
  if (n) params.set('group', String(n));
  else params.delete('group');
  const clean = params.toString();
  history.replaceState(null, '', location.pathname + (clean ? `?${clean}` : ''));
}

/** 从一组查询参数里取合法的组号；非法值当作没写 */
function groupFromParams(params) {
  const n = Number(params.get('group'));
  return Number.isInteger(n) && n >= 1 && n <= GROUP_COUNT ? n : null;
}

async function refreshServerGroups() {
  try {
    const state = await fetchState();
    for (const g of state.groups) app.serverGroups.set(g.group, g);
  } catch {
    /* 连不上就先不显示"已有 N 块" */
  }
  renderGate();
}

/**
 * 进入第 N 组：
 *   - 写 localStorage（下次直接回到这一组）
 *   - 把组号写进地址栏（`?group=N`），老师改 URL 就能改组
 *   - 界面上不提供任何"换组"入口，学生不会误点
 */
function enterGroup(n) {
  app.group = n;
  app.bound = true;
  writeBound(n);
  syncUrl(n);
  document.documentElement.classList.add('has-group');
  els.gate.hidden = true;
  els.groupLabel.textContent = `第 ${n} 组`;

  const mine = app.serverGroups.get(n);
  app.task = normalizeTask(mine?.task);
  if (!taskAllowed(app.task)) app.task = 1;   // 正式模式只允许 1/2/3
  app.tasks = cloneTasks(mine?.tasks);
  const initial = app.tasks[app.task] ?? taskInitial(app.task);
  app.cubes = pipeline(initial);
  app.tasks[app.task] = app.cubes;

  if (!app.stage) initWorkspace();
  renderTaskUi();
  renderLocal();
  setStatus('saved', '已就绪');
}

/** 回到首页（只允许老师用 ?reset 触发） */
function unbind() {
  app.bound = false;
  app.group = null;
  clearBound();
  syncUrl(null);
  document.documentElement.classList.remove('has-group');
  els.gate.hidden = false;
}

// ------------------------------------------------------------------ 工作区

function initWorkspace() {
  app.stage = new CubeStage(els.scene, {
    onPlace: (pos) => handlePlace(pos),
    onMove: (from, to) => {
      const next = app.cubes.filter((c) => key(c) !== key(from));
      next.push(to);
      commit(next);
      app.stage.setSelected(to);   // 挪完继续选中新位置，便于连续调整
      if (app.task === 1) {
        // 任务1：及时提示「再点按钮，移动结束」
        showGuideReminder('已移动木块 · 再点一下「移动木块」结束移动');
      }
    },
    onDelete: (pos) => handleDelete(pos),
    onPlacingChange: () => { /* 放置状态由 app.mode 驱动，界面在 syncModeButtons 里同步 */ },
    onKeyboardModeChange: (on) => {
      els.kbHint.hidden = !on;
    },
    onLockedClick: () => showGuideReminder(),
  });

  // 调试入口：在 DevTools 控制台敲 cubeView() 会打印并返回当前视角角度、允许范围
  window.cubeView = () => app.stage?.logView();

  app.panel = new ViewPanel({
    btn: els.showViews,
    gridEl: els.viewsGrid,
    placeholderEl: els.viewPlaceholder,
    footEl: els.viewFoot,
  });

  // 平板没有右键：视角球负责转视角，「复位视角」按钮负责回正（两件事分开，学生不容易误触）
  app.stage.attachOrbitPad(els.orbitPad);
  els.resetView.addEventListener('click', () => app.stage.resetView());

  // 工具按钮：任务0 三个都在；任务1/2/3 只显示对应那一个。再点一次收起工具。
  for (const btn of els.toolButtons) {
    btn.addEventListener('click', () => {
      const action = btn.dataset.mode;
      if (action === 'place' && isPlaceLocked()) {
        showGuideReminder('任务三只能添加一个木块；要重新来请点「重置木块」');
        return;
      }
      setMode(app.mode === action ? 'none' : action);
    });
  }

  // 「重置」= 回到当前任务最初的摆放（同时解锁任务3、清掉粉色高亮）
  els.resetBtn.addEventListener('click', () => {
    setMode('none');
    app.stage.setSelected(null);
    app.stage.setHighlight(null);
    commit(taskInitial(app.task));
    renderTaskUi();               // 重置后刷新按钮（任务3 的"添上"解锁）
    setStatus('saved', '已重置');
  });

  // 顶栏任务切换
  els.taskTabs.addEventListener('click', (event) => {
    const btn = event.target.closest('.task-tab');
    if (btn) switchTask(btn.dataset.task);
  });

  document.addEventListener('keydown', (event) => {
    const typing = /^(INPUT|TEXTAREA)$/.test(event.target?.tagName ?? '');
    if (typing) return;

    if (event.key === 'Escape') {
      setMode('none');
      app.stage.setSelected(null);
    }
  });
}

/** 任务3 是否已经添加过一块（用于锁定"添上"按钮） */
function isPlaceLocked() {
  return app.task === 3 && app.cubes.length - taskInitial(3).length >= 1;
}

/** 放置（任务3 只允许添加一块，加完标粉并锁定） */
function handlePlace(pos) {
  if (isPlaceLocked()) {
    showGuideReminder('任务三只能添加一个木块；要重新来请点「重置木块」');
    setMode('none');
    return;
  }
  const before = new Set(app.cubes.map(key));
  commit([...app.cubes, pos]);
  if (app.task === 3 && !before.has(key(pos))) {
    app.stage.setHighlight(pos);      // 新添的积木标粉
    setMode('none');                  // 加完就结束连续放置
    renderTaskUi();                   // 锁定「添上」按钮
    setStatus('saved', '已添上一块 · 需要「重置木块」才能再添');
  }
}

/** 拿走（任务2 只允许拿走一块） */
function handleDelete(pos) {
  if (app.task === 2 && taskInitial(2).length - app.cubes.length >= 1) {
    showGuideReminder('任务二只能拿走一个木块；要重新来请点「重置木块」');
    return;
  }
  commit(app.cubes.filter((c) => key(c) !== key(pos)));
}

/** 三个工具互斥：同一时刻只有一个生效（move / erase / place） */
function setMode(mode) {
  app.mode = mode;
  app.stage.setMoveMode(mode === 'move');
  app.stage.setEraseMode(mode === 'erase');
  if (mode === 'place') app.stage.beginPlacing({ sticky: true });
  else app.stage.endPlacing();
  syncModeButtons();
}

function syncModeButtons() {
  const gk = guideKey();
  const action = taskMeta(app.task).action;
  const task0 = app.task === 0;
  const active = task0 ? app.mode !== 'none' : app.mode === action;
  const locked = isPlaceLocked();
  const placeBtn = els.toolButtons.find((b) => b.dataset.mode === 'place');

  for (const btn of els.toolButtons) {
    btn.setAttribute('aria-pressed', String(app.mode === btn.dataset.mode));
  }
  els.stage.dataset.moving = String(app.mode === 'move');
  els.stage.dataset.erasing = String(app.mode === 'erase');
  els.stage.dataset.placing = String(app.mode === 'place');
  els.placingHint.hidden = app.mode !== 'place';

  // 引导跟着工具状态变：没点亮 → 一直提示"先点按钮"并让按钮呼吸；点亮 → 换成"怎么操作"
  const guide = GUIDES[gk];
  if (locked) {
    els.toolStep.textContent = '② 已添上一块 · 点「重置木块」可重来';
    els.guideChip.textContent = '已添一块 · 需要「重置木块」才能再添';
  } else {
    els.toolStep.textContent = app.mode !== 'none'
      ? '② 现在到舞台里操作木块'
      : (task0 ? '① 先点一个工具按钮' : '① 先点下面的按钮');
    els.guideChip.textContent = active ? guide.active : guide.idle;
  }
  els.guideChip.classList.toggle('is-idle', !locked && app.mode === 'none');
  for (const btn of visibleToolButtons()) {
    btn.classList.toggle('is-idle', !locked && app.mode === 'none');
  }

  // 任务3 只能添一块：加完后"添上"按钮变灰锁定；仍可点，点了提示需要重置
  if (placeBtn) {
    placeBtn.classList.toggle('is-locked', locked);
    placeBtn.dataset.locked = String(locked);
  }

  if (app.mode !== 'none') hideGuideReminder();
}

/** 顶栏任务标签 + 工具按钮 + 说明，全部跟着当前任务/模式变 */
function renderTaskUi() {
  const task = app.task;
  // 任务标签：练习模式只显示任务0；正式模式只显示任务1/2/3
  for (const btn of els.taskTabs.querySelectorAll('.task-tab')) {
    const t = Number(btn.dataset.task);
    const show = app.viewMode === 'training' ? t === 0 : (t >= 1 && t <= 3);
    btn.hidden = !show;
    btn.setAttribute('aria-pressed', String(t === task));
  }
  // 工具按钮：任务0 全显示；任务1/2/3 只显示对应那一个
  const action = taskMeta(task).action;
  for (const btn of els.toolButtons) {
    btn.hidden = task === 0 ? false : btn.dataset.mode !== action;
  }
  const gk = guideKey();
  els.toolTip.textContent = TOOL_TIPS[gk];
  els.kbHint.textContent = KB_TIPS[gk];
  syncModeButtons();
}

/** 该任务在当前模式下是否允许 */
function taskAllowed(task) {
  return app.viewMode === 'training' ? task === 0 : (task >= 1 && task <= 3);
}

/** 切换任务（仅正式模式 1/2/3；任务0 是本地练习，没有切换） */
function switchTask(value) {
  const task = normalizeTask(value);
  if (!taskAllowed(task) || task === app.task) return;

  // 把当前任务的进度存回内存，切到目标任务（该任务原来的进度原样保留）
  if (app.task >= 1) app.tasks[app.task] = app.cubes;
  app.task = task;
  setMode('none');
  app.stage.setSelected(null);
  app.stage.setHighlight(null);
  app.cubes = pipeline(app.tasks[task] ?? taskInitial(task));
  app.tasks[task] = app.cubes;
  app.lastEditAt = Date.now();
  app.dirty = true;

  renderTaskUi();
  renderLocal();
  showGuideReminder(`切到${taskMeta(task).name}：先点「${taskMeta(task).actionLabel}」按钮再操作`);
  scheduleSave();
  setStatus('saving', `切到${taskMeta(task).name}`);
}

// ------------------------------------------------------------------ 本地状态

function commit(next) {
  const clean = pipeline(next);
  if (sameCubes(clean, app.cubes)) return;

  app.cubes = clean;
  if (app.task === 0) {
    // 任务0 是本地练习：只存本机，不写服务器
    saveTask0(clean);
    renderLocal();
    return;
  }

  app.tasks[app.task] = clean;   // 只更新当前任务这一槽
  app.lastEditAt = Date.now();
  app.dirty = true;

  renderLocal();
  scheduleSave();
}

function renderLocal() {
  app.stage.setCubes(app.cubes);
  app.panel.setCubes(app.cubes);
  els.cubeCount.textContent = `${app.cubes.length} 块`;
}

function scheduleSave() {
  if (app.task === 0 || !app.group) return;   // 本地练习不保存
  setStatus('saving', '正在保存…');
  clearTimeout(app.saveTimer);
  app.saveTimer = setTimeout(flushSave, SAVE_DEBOUNCE);
}

async function flushSave({ beacon = false } = {}) {
  clearTimeout(app.saveTimer);
  app.saveTimer = null;

  if (!app.group || app.task === 0) return;   // 本地练习不保存
  const group = app.group;
  const cubes = app.cubes.map((c) => [...c]);

  if (beacon) {
    // 统一走 net.js：配置了 apiBase（前后端分开部署）时也要打到正确的后端
    saveGroupBeacon(group, cubes, app.task);
    return;
  }

  app.saving = true;
  try {
    await saveGroup(group, cubes, app.task);
    app.retries = 0;
    if (group === app.group) {
      if (sameCubes(cubes, app.cubes)) {
        app.dirty = false;
        setStatus('saved', `已保存 ${fmtTime(Date.now())}`);
      } else {
        scheduleSave();   // 保存期间又改了，再存一次
      }
    }
  } catch (err) {
    if (group === app.group) {
      app.retries += 1;
      const wait = Math.min(1000 * 2 ** app.retries, 15000);
      setStatus('error', `没保存上（第 ${app.retries} 次），${Math.round(wait / 1000)} 秒后重试`);
      clearTimeout(app.retryTimer);
      app.retryTimer = setTimeout(() => flushSave(), wait);
    }
  } finally {
    app.saving = false;
  }
}

window.addEventListener('pagehide', () => {
  if (app.saveTimer) flushSave({ beacon: true });
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && app.saveTimer) flushSave({ beacon: true });
});

// ------------------------------------------------------------------ 实时同步

function applyState(state) {
  for (const g of state.groups) app.serverGroups.set(g.group, g);
  if (!app.group) return;
  if (app.task === 0) return;   // 本地练习模式不跟随服务器

  const mine = app.serverGroups.get(app.group);
  if (!mine) return;
  const remoteTask = normalizeTask(mine.task);

  // 本机有未保存改动 / 正在保存 / 刚操作过：完全不同步，避免覆盖学生成果
  const recentlyEdited = app.dirty || app.saving || Date.now() - app.lastEditAt < ADOPT_REMOTE_AFTER;
  if (recentlyEdited) return;

  // ⚠ 任务以本机为准，绝不根据服务器上的 task 自动切换本机任务。
  // 以前只要同组有另一个写入方（另一个标签页 / 另一台设备 / 教师放大演示里点重置）
  // 把服务器 task 写成别的值，正在摆放的这台就会在停手 1.2 秒后被拉走
  // （任务三放到一半突然跳回任务一）。一台设备只服务一个组、任务由本机学生选择，
  // 所以服务器 task 只在“首次进入该组”时读取，运行中不跟随。
  // 只同步“本机当前任务这一槽”的方块（这样别人改当前任务的图形仍能看到）。
  app.tasks = cloneTasks(mine.tasks);
  const remote = app.tasks[app.task] ?? taskInitial(app.task);
  if (!sameCubes(remote, app.cubes)) {
    app.cubes = pipeline(remote);
    app.tasks[app.task] = app.cubes;
    renderLocal();
  }
}

function connectStream() {
  app.stream?.close();
  app.stream = openStateStream({
    onState: applyState,
    onStatus: (status, detail) => {
      if (status === 'offline') setStatus('offline', '与服务器断开，正在重连…');
      else if (status === 'reconnecting') setStatus('offline', '重新连接中…');
      else if (status === 'polling') {
        // 轮询只是"传输方式"，不是"正在保存"。不能覆盖掉"已保存 xx:xx:xx"，
        // 否则 Vercel 部署下学生永远看不到保存时间。
        if (!app.dirty && ['offline', 'loading'].includes(els.status.dataset.state)) {
          setStatus('saved', '已同步');
        }
      }
      else if (status === 'live' && els.status.dataset.state === 'offline') {
        setStatus('saved', '已重新连上');
      }
      if (status === 'offline' && detail) console.warn('连接问题：', detail);
    },
  });
}

// ------------------------------------------------------------------ 启动

async function boot() {
  setStatus('loading', '连接中…');
  // 与"读服务器设置"并行拉一次组状态，少等一次网络往返（首屏更快）
  const groupsReady = refreshServerGroups();
  app.viewMode = await resolveViewMode();

  // 练习模式：只显示任务0，本地练习，不需要/不影响任何组的正式数据（也不连服务器）
  if (app.viewMode === 'training') {
    startPractice();
    return;
  }

  await groupsReady;

  const params = new URLSearchParams(location.search);
  const wantsReset = params.has('reset');
  // 老师可以一次到位：/?reset&group=5 —— 先解绑，再进第 5 组
  const presetGroup = groupFromParams(params);

  if (wantsReset) {
    unbind();   // 清 localStorage + 从地址栏去掉 group/reset
  }

  await refreshServerGroups();

  // 优先级：地址栏的 ?group= > localStorage > 首页
  // 地址栏优先是刻意的：老师把 URL 改成 ?group=6，这台机器就换到第 6 组。
  const urlGroup = wantsReset ? presetGroup : groupFromParams(new URLSearchParams(location.search));
  const initial = wantsReset ? (presetGroup ?? readBound()) : (urlGroup ?? readBound());

  if (initial) {
    enterGroup(initial);
  } else {
    els.gate.hidden = false;
  }

  connectStream();
}

/** 练习模式（任务0）：本地操作、四个按钮都能用，不读/写服务器 */
function startPractice() {
  app.viewMode = 'training';
  app.group = null;
  app.bound = false;
  document.documentElement.classList.add('has-group');
  els.gate.hidden = true;
  els.groupLabel.textContent = '练习模式';
  app.task = 0;
  app.cubes = readTask0();
  if (!app.stage) initWorkspace();
  renderTaskUi();
  renderLocal();
  setStatus('saved', '练习模式 · 只在本机保存');
}

boot();
