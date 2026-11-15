/**
 * 设置页：选择这台设备显示「任务0（练习）」还是「任务1·2·3（正式）」。
 *
 * 只存在本机 localStorage，不改服务器数据；返回学生端后生效（学生端会读同一个 key）。
 * 默认 formal（保持原有行为）。
 */
const KEY = 'cube-views:mode';
const choices = [...document.querySelectorAll('.settings-choice')];
const note = document.getElementById('settingsNote');

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

for (const btn of choices) {
  btn.addEventListener('click', () => {
    const mode = btn.dataset.mode === 'training' ? 'training' : 'formal';
    try {
      localStorage.setItem(KEY, mode);
    } catch {
      /* 隐私模式下存不了：只本页提示 */
      note.textContent = '这台设备无法保存设置（浏览器禁用了本地存储）';
      return;
    }
    render();
    note.textContent = `已保存 ✓ 当前：${label(mode)}，返回学生端后生效`;
  });
}

render();
