/**
 * 浏览器加载器（给 scripts/ 下的端到端验证脚本共用）。
 *
 * 设计目标：换一台电脑也能跑，不依赖任何人的家目录。
 *
 * 1) playwright-core 从项目自身的 devDependencies 解析（先 npm install）；
 *    也可以设 PLAYWRIGHT_CORE=/path/to/playwright-core/index.js 覆盖。
 * 2) 浏览器可执行文件按下面顺序找：
 *    - CHROME_PATH / PLAYWRIGHT_CHROMIUM_PATH / AUDIT_EXE（显式指定）
 *    - PLAYWRIGHT_BROWSERS_PATH（或各平台默认缓存目录）里的 chromium / headless shell
 *    - playwright-core 自己算出来的 executablePath()
 *    - 系统安装的 Chrome / Chromium
 *
 * 都找不到时给出可直接复制的安装命令，而不是一堆看不懂的堆栈。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';

const IS_WIN = process.platform === 'win32';

const EXE_NAMES = IS_WIN
  ? ['chrome-headless-shell.exe', 'headless_shell.exe', 'chrome.exe', 'msedge.exe']
  : ['chrome-headless-shell', 'headless_shell', 'chrome', 'google-chrome',
     'chromium', 'chromium-browser', 'Google Chrome', 'Chromium'];

function isFile(p) {
  try {
    return !!p && fs.existsSync(p) && fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function envCandidates() {
  return [
    process.env.CHROME_PATH,
    process.env.PLAYWRIGHT_CHROMIUM_PATH,
    process.env.AUDIT_EXE,       // audit.mjs 历史上用的名字，保留兼容
  ].filter(isFile);
}

function browserRoots() {
  const roots = [];
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) roots.push(process.env.PLAYWRIGHT_BROWSERS_PATH);
  // 有些团队把浏览器缓存放在项目旁边的 .pw-browsers（本工作区就是这样），顺手找一下
  roots.push(path.resolve(process.cwd(), '..', '.pw-browsers'));
  roots.push(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '.pw-browsers'));
  const home = os.homedir();
  if (IS_WIN) {
    roots.push(path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'ms-playwright'));
  } else if (process.platform === 'darwin') {
    roots.push(path.join(home, 'Library', 'Caches', 'ms-playwright'));
  } else {
    roots.push(path.join(home, '.cache', 'ms-playwright'));
  }
  return roots.filter((p) => fs.existsSync(p));
}

/** 在 Playwright 浏览器目录里找可执行文件（限深，避免扫到无关大目录） */
function scanForBrowser(dir, depth = 0) {
  const found = [];
  if (depth > 4) return found;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && EXE_NAMES.includes(entry.name) && isFile(full)) {
      found.push(full);
    } else if (entry.isDirectory() && !entry.name.startsWith('.')) {
      found.push(...scanForBrowser(full, depth + 1));
    }
  }
  return found;
}

function systemCandidates() {
  if (IS_WIN) {
    return [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    ];
  }
  if (process.platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ];
  }
  return [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ];
}

export async function loadBrowser() {
  let mod;
  try {
    if (process.env.PLAYWRIGHT_CORE) {
      const file = path.resolve(process.env.PLAYWRIGHT_CORE);
      mod = await import(pathToFileURL(file).href);
    } else {
      mod = await import('playwright-core');
    }
  } catch (err) {
    throw new Error(
      '加载 playwright-core 失败。请在项目目录执行 `npm install`；' +
      '如果装在别处，可设 PLAYWRIGHT_CORE 指向它的 index.js。\n' + (err?.message || err),
    );
  }
  const chromium = mod?.chromium ?? mod?.default?.chromium;
  if (!chromium) throw new Error('playwright-core 里没有找到 chromium');

  const candidates = [...envCandidates()];
  for (const root of browserRoots()) candidates.push(...scanForBrowser(root));
  try {
    const p = chromium.executablePath?.();
    if (isFile(p)) candidates.push(p);
  } catch { /* 某些版本没有这个方法，忽略 */ }
  candidates.push(...systemCandidates());

  const executablePath = candidates.find(isFile);
  if (!executablePath) {
    throw new Error(
      '找不到浏览器可执行文件。任选一种：\n' +
      '  1) 系统已装 Chrome：export CHROME_PATH="/path/to/Chrome"\n' +
      '  2) 下载 Playwright 浏览器：npx playwright-core install chromium-headless-shell\n' +
      '  3) 已有浏览器缓存：export PLAYWRIGHT_BROWSERS_PATH="/path/to/ms-playwright"',
    );
  }
  return { chromium, executablePath };
}
