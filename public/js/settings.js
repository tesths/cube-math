/**
 * 设置页（教师专属）：选择所有设备显示「任务0（练习）」还是「任务1·2·3（正式）」。
 *
 * - 先通过教师口令（config.js 的 settingsPin）才能看到选项；
 * - 选项写到**服务器**（/api/settings），所以教师电脑上设置，学生平板刷新就生效；
 *   同时写一份本机 localStorage 作为离线兜底。
 * - 默认 formal。
 *
 * 这是纯前端口令门，用于挡住学生误入/乱点，不是强安全措施。
 */
import { fetchSettings, saveSettings } from './shared/net.js';

const KEY = 'cube-views:mode';
const PIN = String(globalThis.CUBE_VIEWS_CONFIG?.settingsPin ?? '8888');

const lockEl = document.getElementById('settingsLock');
const bodyEl = document.getElementById('settingsBody');
const form = document.getElementById('settingsForm');
const pinInput = document.getElementById('settingsPin');
const lockNote = document.getElementById('lockNote');
const note = document.getElementById('settingsNote');
const choices = [...document.querySelectorAll('.settings-choice')];

let currentMode = 'formal';

function localMode() {
  try {
    return localStorage.getItem(KEY) === 'training' ? 'training' : 'formal';
  } catch {
    return 'formal';
  }
}

function writeLocal(mode) {
  try {
    localStorage.setItem(KEY, mode);
  } catch { /* 忽略 */ }
}

function label(mode) {
  return mode === 'training' ? '任务 0（练习模式）' : '任务 1·2·3（正式任务）';
}

function render() {
  for (const btn of choices) {
    btn.setAttribute('aria-pressed', String(btn.dataset.mode === currentMode));
  }
  note.textContent = `当前：${label(currentMode)}`;
}

/** 从服务器读取当前设置（读不到就用本机） */
async function load() {
  let mode = localMode();
  try {
    const s = await fetchSettings();
    if (s?.mode === 'training' || s?.mode === 'formal') mode = s.mode;
  } catch { /* 服务器不可用，用本机 */ }
  currentMode = mode;
  writeLocal(mode);
  render();
}

function unlock() {
  lockEl.hidden = true;
  bodyEl.hidden = false;
  load();
  document.querySelector('.settings-choice')?.focus();
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  if (pinInput.value.trim() === PIN) {
    unlock();
  } else {
    lockNote.textContent = '口令不对，请重试';
    pinInput.value = '';
    pinInput.focus();
  }
});

for (const btn of choices) {
  btn.addEventListener('click', async () => {
    const mode = btn.dataset.mode === 'training' ? 'training' : 'formal';
    currentMode = mode;
    writeLocal(mode);
    render();
    note.textContent = '正在保存到服务器…';
    try {
      await saveSettings(mode);
      note.textContent = `已保存到服务器 ✓ 当前：${label(mode)}（学生端刷新即生效）`;
    } catch (err) {
      note.textContent = `保存到服务器失败：${err.message}（已在本机生效）`;
    }
  });
}

pinInput.focus();
