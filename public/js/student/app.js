/**
 * 学生端主程序：首页认领自己的组 → 摆放 → 看三视图 → 自动保存。
 *
 * 认领之后这台设备就固定在这一组（没有"换组"入口），避免学生误点别的组、
 * 把别人的作品覆盖掉。老师要给某台机器换组，用 `/?reset` 打开一次即可。
 */
import { CubeStage } from './stage.js';
import { ViewPanel } from './views.js';
import { sanitizeLoose, collapseColumns, taskInitial, taskMeta, normalizeTask } from '../shared/model.js';
import { openStateStream, saveGroup, saveGroupBeacon, fetchState } from '../shared/net.js';

const GROUP_COUNT = 8;
const LS_KEY = 'cube-views:group';
const SAVE_DEBOUNCE = 350;
const ADOPT_REMOTE_AFTER = 1200;   // 自己刚改完的这段时间内忽略服务器回声，免得和手速打架

const $ = (id) => document.getElementById(id);

const els = {
  gate: $('gate'),
  groupGrid: $('groupGrid'),
  groupLabel: $('groupLabel'),
  status: $('status'),
  statusText: $('statusText'),
  actionBtn: $('actionBtn'),
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
  task: 1,               // 1=移动 2=拿走 3=添上
  tasks: {},             // 三个任务各自的进度（切任务不丢）
  mode: 'none',          // 'none' | 'move' | 'erase' | 'place'
};

const TOOL_TIPS = {
  move: '先点「移动木块」按钮，才能点木块；点中一块再点目标格子就能挪过去，也可以直接拖动。「重置木块」回到这个任务最初的样子。',
  erase: '先点「拿走木块」按钮，才能点木块；点任意木块就把它拿走，上面的木块会自动落下。「重置木块」回到这个任务最初的样子。',
  place: '先点「添上木块」按钮，才能加木块；点木块顶面或空格子就能添一块，再点一次按钮或按 Esc 结束。「重置木块」回到这个任务最初的样子。',
};

/** 两步引导：没点亮工具时提示「先点按钮」，点亮后提示「现在怎么操作」 */
const GUIDES = {
  move:  { idle: '① 先点左边「移动木块」按钮',   active: '② 点中一块，再点目标格子（或直接拖动）' },
  erase: { idle: '① 先点左边「拿走木块」按钮',   active: '② 点任意木块，就把它拿走' },
  place: { idle: '① 先点「添上木块」按钮',       active: '② 点木块顶面或空格子，就能添一块' },
};

let guideTimer = null;

const KB_TIPS = {
  move: '方向键选格子 · 回车把选中的木块挪过去',
  erase: '方向键选格子 · Delete 拿走那一列最上面一块',
  place: '方向键选格子 · 回车添一块',
};

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

/** 没先点工具按钮就点木块 / 按键盘：弹一条提醒，并把按钮再闪一下 */
function showGuideReminder(message) {
  const label = taskMeta(app.task).actionLabel;
  els.guideToast.textContent = message ?? `先点左边的「${label}」按钮，再操作木块`;
  els.guideToast.hidden = false;

  els.actionBtn.classList.remove('nudge');
  void els.actionBtn.offsetWidth;      // 强制重排，让动画每次都能重新播放
  els.actionBtn.classList.add('nudge');
  clearTimeout(guideTimer);
  guideTimer = setTimeout(hideGuideReminder, 2600);
}

function hideGuideReminder() {
  clearTimeout(guideTimer);
  guideTimer = null;
  els.guideToast.hidden = true;
  els.actionBtn.classList.remove('nudge');
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
    onPlace: (pos) => commit([...app.cubes, pos]),
    onMove: (from, to) => {
      const next = app.cubes.filter((c) => key(c) !== key(from));
      next.push(to);
      commit(next);
      app.stage.setSelected(to);   // 挪完继续选中新位置，便于连续调整
    },
    onDelete: (pos) => commit(app.cubes.filter((c) => key(c) !== key(pos))),
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

  // 左侧动作按钮，内容随任务变化：移动木块 / 拿走木块 / 添上木块；再点一次收起工具
  els.actionBtn.addEventListener('click', () => {
    const action = taskMeta(app.task).action;
    setMode(app.mode === action ? 'none' : action);
  });

  // 「重置」= 回到当前任务最初的摆放
  els.resetBtn.addEventListener('click', () => {
    setMode('none');
    app.stage.setSelected(null);
    commit(taskInitial(app.task));
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
  const action = taskMeta(app.task).action;
  const active = app.mode === action;
  els.actionBtn.setAttribute('aria-pressed', String(active));
  els.stage.dataset.moving = String(app.mode === 'move');
  els.stage.dataset.erasing = String(app.mode === 'erase');
  els.stage.dataset.placing = String(app.mode === 'place');
  els.placingHint.hidden = app.mode !== 'place';

  // 引导跟着工具状态变：没点亮 → 一直提示"先点按钮"并让按钮呼吸；点亮 → 换成"怎么操作"
  const guide = GUIDES[action];
  els.toolStep.textContent = active ? '② 现在到舞台里操作木块' : '① 先点下面的按钮';
  els.guideChip.textContent = active ? guide.active : guide.idle;
  els.guideChip.classList.toggle('is-idle', !active);
  els.actionBtn.classList.toggle('is-idle', !active);
  if (active) hideGuideReminder();
}

/** 顶栏任务标签 + 左侧按钮文案 + 说明，全部跟着当前任务变 */
function renderTaskUi() {
  const meta = taskMeta(app.task);
  for (const btn of els.taskTabs.querySelectorAll('.task-tab')) {
    btn.setAttribute('aria-pressed', String(Number(btn.dataset.task) === app.task));
  }
  els.actionBtn.textContent = meta.actionLabel;
  els.toolTip.textContent = TOOL_TIPS[meta.action];
  els.kbHint.textContent = KB_TIPS[meta.action];
  syncModeButtons();
}

/** 切换任务：把这一组重置成该任务的初始摆放并保存 */
function switchTask(value) {
  const task = normalizeTask(value);
  if (task === app.task) return;

  // 把当前任务的进度存回内存，切到目标任务（该任务原来的进度原样保留）
  app.tasks[app.task] = app.cubes;
  app.task = task;
  setMode('none');
  app.stage.setSelected(null);
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
  setStatus('saving', '正在保存…');
  clearTimeout(app.saveTimer);
  app.saveTimer = setTimeout(flushSave, SAVE_DEBOUNCE);
}

async function flushSave({ beacon = false } = {}) {
  clearTimeout(app.saveTimer);
  app.saveTimer = null;

  if (!app.group) return;
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

boot();
