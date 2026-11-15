/**
 * 把 three.js 从 node_modules 复制到 public/vendor/，让页面完全不依赖 CDN（断网可用）。
 * 运行：npm run vendor
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'node_modules', 'three');
const dest = path.join(root, 'public', 'vendor');

const files = [
  ['build/three.module.js', 'three.module.js'],
  ['build/three.core.js', 'three.core.js'],
  ['examples/jsm/controls/OrbitControls.js', 'addons/controls/OrbitControls.js'],
];

for (const [from, to] of files) {
  const target = path.join(dest, to);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.copyFile(path.join(src, from), target);
  const { size } = await fs.stat(target);
  console.log(`  ✓ vendor/${to}  (${(size / 1024).toFixed(0)} KB)`);
}

await fs.writeFile(
  path.join(dest, 'VERSION.txt'),
  `three.js vendored from node_modules/three\n`,
);

console.log('vendoring 完成');
