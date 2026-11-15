/**
 * 设置页（教师专属）：选择这台设备显示「任务0（练习）」还是「任务1·2·3（正式）」。
 *
 * - 先要通过教师口令（config.js 里的 settingsPin）才能看到选项，学生即使知道网址也进不来；
 * - 选项只存在本机 localStorage，不改服务器数据；返回学生端后生效（学生端读同一个 key）。
 * - 默认 formal（保持原有行为）。
 *
 * 说明：这是纯前端口令门，用于挡住学生误入/乱点，不是强安全措施；
 * 需要改口令就改 config.js 的 settingsPin（部署后无需重新构建）。
 */
const KEY = 'cube-views:mode';
const PIN = String(globalThis.CUBE_VIEWS_CONFIG?.settingsPin ?? '8888');

const lockEl = document.getElementById('settingsLock');
const bodyEl = document.getElementById('settingsBody');
const form = document.getElementById('settingsForm');
const pinInput = document.getElementById('settingsPin');
const lockNote = document.getElementById('lockNote');
const note = document.getElementById('settingsNote');
const choices = [...document.querySelectorAll('.settings-choice')];

function current() {
  try {
    return localStorage.getItem(KEY) === 'training' ? 'training' : 'formal';
  } catch {
    return 'formal';
  }
}

function label(mode) {
  return mode === 'training' ? '任务 0（练习模式）' : '任务 1·2·3（正式任务）';
}

function render() {
  const mode = current();
  for (const btn of choices) {
    btn.setAttribute('aria-pressed', String(btn.dataset.mode === mode));
  }
  note.textContent = `当前：${label(mode)}`;
}

function unlock() {
  lockEl.hidden = true;
  bodyEl.hidden = false;
  render();
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
  btn.addEventListener('click', () => {
    const mode = btn.dataset.mode === 'training' ? 'training' : 'formal';
    try {
      localStorage.setItem(KEY, mode);
    } catch {
      note.textContent = '这台设备无法保存设置（浏览器禁用了本地存储）';
      return;
    }
    render();
    note.textContent = `已保存 ✓ 当前：${label(mode)}，返回学生端后生效`;
  });
}

// 进入页面时只显示口令门（不持久化解锁，学生拿到设备也进不去）
pinInput.focus();
