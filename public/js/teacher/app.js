/**
 * 教师端：一屏看 8 个小组，点某一个组可以放大演示（界面与学生端一致，方便投大屏讲课）。
 * 数据来自 SSE 推送（无服务器环境自动降级为轮询），学生一改，这里秒级同步。
 */
import { MiniStage } from './mini.js';
import { CubeStage } from '../student/stage.js';
import { ViewCards } from '../student/views.js';
import { openStateStream, fetchState, saveGroup } from '../shared/net.js';
import { sanitizeLoose, collapseColumns, taskInitial, taskMeta, normalizeTask } from '../shared/model.js';

const GROUP_COUNT = 8;
const $ = (id) => document.getElementById(id);

const els = {
  board: $('board'),
  status: $('status'),
  statusText: $('statusText'),
  summary: $('summary'),
  focusLayer: $('focusLayer'),
  focusName: $('focusName'),
  focusMeta: $('focusMeta'),
  focusClose: $('focusClose'),
  focusScene: $('focusScene'),
  focusStage: $('focusStage'),
  focusViews: $('focusViews'),
  focusOrbitPad: $('focusOrbitPad'),
  focusReset: $('focusReset'),
  focusActionBtn: $('focusActionBtn'),
  focusToolStep: $('focusToolStep'),
  focusResetBtn: $('focusResetBtn'),
  focusToolTip: $('focusToolTip'),
  focusGuideChip: $('focusGuideChip'),
  focusGuideToast: $('focusGuideToast'),
};

const TOOL_TIPS = {
  move: '先点「移动木块」按钮，才能点木块；点中一块再点目标格子就能挪过去，也可以直接拖动。改完会自动保存。',
  erase: '先点「拿走木块」按钮，才能点木块；点任意木块就把它拿走，上面的木块会自动落下。改完会自动保存。',
  place: '先点「添上木块」按钮，才能加木块；点木块顶面或空格子就能添一块。改完会自动保存。',
};

/** 放大演示也是同一道闸门，引导文案与学生端一致 */
const FOCUS_GUIDES = {
  move:  { idle: '① 先点左边「移动木块」按钮',   active: '② 点中一块，再点目标格子（或直接拖动）' },
  erase: { idle: '① 先点左边「拿走木块」按钮',   active: '② 点任意木块，就把它拿走' },
  place: { idle: '① 先点「添上木块」按钮',       active: '② 点木块顶面或空格子，就能添一块' },
};

let focusGuideTimer = null;

/** @type {Map<number, object>} */
const cards = new Map();

let focus = null;   // { group, stage, views, task, cubes, mode, dirty, saving, lastEditAt, saveTimer }

// 调试入口：放大演示打开后，在 DevTools 敲 cubeView() 可查当前角度（与学生端同名同格式）
window.cubeView = () => focus?.stage?.logView();

function setStatus(state, text) {
  els.status.dataset.state = state;
  els.statusText.textContent = text;
}

/** 没先点工具按钮就点木块：弹提醒 + 让按钮再闪一下 */
function showFocusGuide(message) {
  if (!focus) return;
  const label = taskMeta(focus.task).actionLabel;
  els.focusGuideToast.textContent = message ?? `先点左边的「${label}」按钮，再操作木块`;
  els.focusGuideToast.hidden = false;
  els.focusActionBtn.classList.remove('nudge');
  void els.focusActionBtn.offsetWidth;
  els.focusActionBtn.classList.add('nudge');
  clearTimeout(focusGuideTimer);
  focusGuideTimer = setTimeout(hideFocusGuide, 2600);
}

function hideFocusGuide() {
  clearTimeout(focusGuideTimer);
  focusGuideTimer = null;
  els.focusGuideToast.hidden = true;
  els.focusActionBtn.classList.remove('nudge');
}

function relTime(ts) {
  if (!ts) return '—';
  const diff = Date.now() - ts;
  if (diff < 15000) return '刚刚';
  if (diff < 60000) return `${Math.floor(diff / 1000)} 秒前`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
  return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false }).slice(0, 5);
}

function maxHeight(cubes) {
  let max = 0;
  for (const [, y] of cubes) max = Math.max(max, y + 1);
  return max;
}

function describe(cubes) {
  return cubes.length ? `${cubes.length} 块 · ${maxHeight(cubes)} 层` : '还没有开始';
}

function buildBoard() {
  for (let i = 1; i <= GROUP_COUNT; i++) {
    const card = document.createElement('article');
    card.className = 'group-card';
    card.dataset.group = String(i);

    const header = document.createElement('header');
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = `第 ${i} 组`;
    const taskTag = document.createElement('span');
    taskTag.className = 'task-tag';
    taskTag.textContent = '任务一';
    const count = document.createElement('span');
    count.className = 'count';
    count.textContent = '还没有开始';
    const when = document.createElement('span');
    when.className = 'when';
    when.textContent = '—';
    // 明确的"放大"按钮：大屏/触屏没有 hover，光靠"整张卡片可点"不容易被发现
    const zoom = document.createElement('button');
    zoom.type = 'button';
    zoom.className = 'card-open';
    zoom.textContent = '放大';
    zoom.setAttribute('aria-label', `放大第 ${i} 组`);
    header.append(name, taskTag, count, when, zoom);

    const stageBox = document.createElement('div');
    stageBox.className = 'card-stage';
    const canvas = document.createElement('canvas');
    const empty = document.createElement('div');
    empty.className = 'card-empty';
    const emptyText = document.createElement('span');
    emptyText.textContent = '还没有开始摆';
    empty.append(emptyText);
    stageBox.append(canvas, empty);

    card.append(header, stageBox);
    els.board.append(card);

    const open = () => openFocus(i);
    zoom.addEventListener('click', (event) => {
      event.stopPropagation();
      open();
    });
    // 整张卡片也可以点，老师不用瞄准按钮
    card.addEventListener('click', open);

    const stage = new MiniStage(canvas);
    cards.set(i, { card, canvas, empty, count, when, taskTag, stage, cubes: [], tasks: {}, updatedAt: 0, task: 1 });
  }

  const resizeAll = () => {
    for (const entry of cards.values()) entry.stage.resize();
  };
  new ResizeObserver(resizeAll).observe(els.board);
  requestAnimationFrame(resizeAll);
  window.addEventListener('resize', resizeAll);
}

function updateSummary() {
  let started = 0;
  let total = 0;
  for (const entry of cards.values()) {
    if (entry.cubes.length > 0) started++;
    total += entry.cubes.length;
  }
  els.summary.textContent = `${started} / ${GROUP_COUNT} 组已开始 · 共 ${total} 块`;
}

function applyState(state) {
  for (const g of state.groups) {
    const entry = cards.get(g.group);
    if (!entry) continue;

    const task = normalizeTask(g.task);
    const tasks = {
      1: cloneCubes(g.tasks?.[1] ?? taskInitial(1)),
      2: cloneCubes(g.tasks?.[2] ?? taskInitial(2)),
      3: cloneCubes(g.tasks?.[3] ?? taskInitial(3)),
    };
    const cubes = tasks[task] ?? taskInitial(task);
    const changed = g.updatedAt !== entry.updatedAt || task !== entry.task || cubes.length !== entry.cubes.length;

    entry.task = task;
    entry.tasks = tasks;
    entry.cubes = cubes;
    entry.updatedAt = g.updatedAt;

    entry.taskTag.textContent = taskMeta(task).name;
    entry.count.textContent = describe(cubes);
    entry.when.textContent = cubes.length && g.updatedAt ? relTime(g.updatedAt) : '—';
    entry.empty.hidden = cubes.length > 0;
    entry.card.dataset.empty = String(cubes.length === 0);
    // 只有内容真的变了才重建 mesh：轮询模式下每 2 秒重建 8 张卡很浪费
    if (changed) entry.stage.setCubes(cubes);

    if (changed && entry.initialized) {
      entry.card.dataset.updated = 'true';
      setTimeout(() => { entry.card.dataset.updated = 'false'; }, 260);
    }
    entry.initialized = true;
  }
  updateSummary();
  if (focus) refreshFocus(state);
}

// ---------------------------------------------------------------- 放大演示

function cloneCubes(list) {
  return (list ?? []).map((c) => [...c]);
}

function entryCubes(entry) {
  return cloneCubes(entry.tasks?.[entry.task] ?? taskInitial(entry.task));
}

function openFocus(group) {
  const entry = cards.get(group);
  if (!entry) return;

  if (!focus) {
    const stage = new CubeStage(els.focusScene, {
      onPlace: (pos) => commitFocus([...focus.cubes, pos]),
      onMove: (from, to) => {
        const next = focus.cubes.filter((c) => c.join(',') !== from.join(','));
        next.push(to);
        commitFocus(next);
        focus.stage.setSelected(to);   // 挪完继续选中，方便连续调整
      },
      onDelete: (pos) => commitFocus(focus.cubes.filter((c) => c.join(',') !== pos.join(','))),
      onPlacingChange: () => {},
      onKeyboardModeChange: () => {},
      onLockedClick: () => showFocusGuide(),
    });
    stage.attachOrbitPad(els.focusOrbitPad);
    focus = {
      stage,
      views: new ViewCards(els.focusViews, { maxCell: 96, minCell: 16 }),
      group: null, task: 1, cubes: [], mode: 'none',
      dirty: false, saving: false, lastEditAt: 0, saveTimer: null,
    };
  }

  focus.group = group;
  focus.task = entry.task;
  focus.cubes = entryCubes(entry);
  focus.dirty = false;
  focus.mode = 'none';

  renderFocusTools();
  els.focusName.textContent = `第 ${group} 组 · ${taskMeta(focus.task).name}`;
  els.focusMeta.textContent = `${taskMeta(focus.task).name} · ${describe(focus.cubes)}`;
  els.focusLayer.hidden = false;
  document.body.classList.add('is-focusing');
  els.board.setAttribute('inert', '');      // 背后的 8 宫格暂时不可点、不可 Tab 进去

  // 布局完成后再测量尺寸，否则 canvas 会拿不到宽高
  requestAnimationFrame(() => {
    focus.stage.resetView();
    focus.stage.setCubes(focus.cubes);
    focus.views.setCubes(focus.cubes);
    focus.views.render();
  });
  els.focusClose.focus({ preventScroll: true });
  showFocusGuide();          // 打开就先提醒一次：这一步要点按钮
}

function renderFocusTools() {
  if (!focus) return;
  const meta = taskMeta(focus.task);
  els.focusActionBtn.textContent = meta.actionLabel;
  els.focusToolTip.textContent = TOOL_TIPS[meta.action];
  setFocusMode(focus.mode);
}

function setFocusMode(mode) {
  if (!focus) return;
  focus.mode = mode;
  focus.stage.setMoveMode(mode === 'move');
  focus.stage.setEraseMode(mode === 'erase');
  if (mode === 'place') focus.stage.beginPlacing({ sticky: true });
  else focus.stage.endPlacing();

  const action = taskMeta(focus.task).action;
  const active = mode === action;
  els.focusActionBtn.setAttribute('aria-pressed', String(active));

  const guide = FOCUS_GUIDES[action];
  els.focusToolStep.textContent = active ? '② 现在到舞台里操作木块' : '① 先点下面的按钮';
  els.focusGuideChip.textContent = active ? guide.active : guide.idle;
  els.focusGuideChip.classList.toggle('is-idle', !active);
  els.focusActionBtn.classList.toggle('is-idle', !active);
  if (active) hideFocusGuide();
}

/** 老师改了以后先把这一组更新到界面，再防抖保存回服务器（学生端会跟着变） */
function commitFocus(next) {
  if (!focus) return;
  const clean = collapseColumns(sanitizeLoose(next).cubes);
  if (JSON.stringify(clean) === JSON.stringify(focus.cubes)) return;

  focus.cubes = clean;
  focus.dirty = true;
  focus.lastEditAt = Date.now();
  focus.stage.setCubes(clean);
  focus.views.setCubes(clean);
  focus.views.render();
  els.focusMeta.textContent = `${taskMeta(focus.task).name} · ${describe(clean)}`;

  clearTimeout(focus.saveTimer);
  focus.saveTimer = setTimeout(flushFocus, 350);
}

async function flushFocus() {
  if (!focus || !focus.dirty) return;
  const group = focus.group;
  const task = focus.task;
  const cubes = focus.cubes.map((c) => [...c]);
  focus.saving = true;
  try {
    await saveGroup(group, cubes, task);
    if (focus && focus.group === group && focus.task === task && JSON.stringify(focus.cubes) === JSON.stringify(cubes)) {
      focus.dirty = false;
      // 顺手更新卡片缓存，免得紧接着的轮询用旧数据把它覆盖回去
      const entry = cards.get(group);
      if (entry) {
        entry.tasks = { ...entry.tasks, [task]: cubes };
        entry.cubes = cubes;
        entry.updatedAt = Date.now();
        entry.count.textContent = describe(cubes);
        entry.empty.hidden = cubes.length > 0;
        entry.card.dataset.empty = String(cubes.length === 0);
        entry.stage.setCubes(cubes);
      }
    }
  } catch (err) {
    console.warn('教师端保存失败：', err.message);
    if (focus) focus.saveTimer = setTimeout(flushFocus, 1500);
  } finally {
    focus.saving = false;
  }
}

function closeFocus() {
  if (!focus) return;
  if (focus.dirty) flushFocus();            // 关掉前把没保存的改动送上去
  els.focusLayer.hidden = true;
  document.body.classList.remove('is-focusing');
  els.board.removeAttribute('inert');
  hideFocusGuide();
  setFocusMode('none');
  cards.get(focus.group)?.card.focus({ preventScroll: true });
}

function refreshFocus(state) {
  if (!focus) return;
  const g = state.groups.find((item) => item.group === focus.group);
  if (!g) return;

  const task = normalizeTask(g.task);
  const cubes = cloneCubes(g.tasks?.[task] ?? taskInitial(task));

  // 老师刚改过（还没保存完）时，不要被服务器回声覆盖
  // 正在用工具 / 有未保存改动 / 刚改过：不要拿远端状态覆盖（包括任务被切走）
  if (focus.mode !== 'none' || focus.dirty || focus.saving || Date.now() - focus.lastEditAt < 900) return;

  if (task !== focus.task) {
    focus.task = task;
    renderFocusTools();
  }
  els.focusMeta.textContent = `${taskMeta(task).name} · ${describe(cubes)}`;
  if (JSON.stringify(cubes) !== JSON.stringify(focus.cubes)) {
    focus.cubes = cubes;
    focus.stage.setCubes(cubes);
    focus.views.setCubes(cubes);
    focus.views.render();
  }
}

els.focusActionBtn.addEventListener('click', () => {
  if (!focus) return;
  const action = taskMeta(focus.task).action;
  setFocusMode(focus.mode === action ? 'none' : action);
});
els.focusResetBtn.addEventListener('click', () => {
  if (!focus) return;
  setFocusMode('none');
  focus.stage.setSelected(null);
  commitFocus(taskInitial(focus.task));
});
els.focusClose.addEventListener('click', closeFocus);
els.focusReset.addEventListener('click', () => focus?.stage.resetView());
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && focus && !els.focusLayer.hidden) closeFocus();
});

// ---------------------------------------------------------------- 启动

function refreshTimes() {
  for (const entry of cards.values()) {
    entry.when.textContent = entry.cubes.length && entry.updatedAt ? relTime(entry.updatedAt) : '—';
  }
}

async function boot() {
  buildBoard();
  setStatus('loading', '连接中…');

  try {
    applyState(await fetchState());
  } catch {
    setStatus('offline', '还没连上服务器…');
  }

  openStateStream({
    onState: applyState,
    onStatus: (status) => {
      if (status === 'live') setStatus('saved', '实时同步中');
      else if (status === 'connecting') setStatus('loading', '连接中…');
      else if (status === 'polling') {
        const secs = Math.round((Number(globalThis.CUBE_VIEWS_CONFIG?.pollMs) || 2000) / 1000);
        setStatus('saving', `慢速同步中（每 ${secs} 秒刷新）`);
      }
      else setStatus('offline', '连接断开，正在重连…');
    },
  });

  setInterval(refreshTimes, 5000);
}

boot();
