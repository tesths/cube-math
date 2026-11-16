/**
 * 把学生端 / 教师端的自有 ES 模块打包成**单个压缩文件**，减少跨境请求数和体积。
 *
 * - three / three/addons 作为 external（运行时由 importmap 指向国内 npmmirror），不进 bundle；
 * - 输出 public/js/student/app.bundle.js、public/js/teacher/app.bundle.js；
 * - HTML 里 <script type="module" src> 指向 bundle。
 *
 * 用法：node scripts/build-web.mjs   （npm start 的 prestart 会自动跑）
 * 改了 public/js 下的源码后需要重新打包。
 */
import { build } from 'esbuild';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const targets = [
  { entry: 'public/js/student/app.js', out: 'public/js/student/app.bundle.js' },
  { entry: 'public/js/teacher/app.js', out: 'public/js/teacher/app.bundle.js' },
];

for (const t of targets) {
  await build({
    absWorkingDir: ROOT,
    entryPoints: [t.entry],
    outfile: t.out,
    bundle: true,
    format: 'esm',
    target: 'es2020',
    minify: true,
    legalComments: 'none',
    // 第三方库保持 external，运行时由 importmap 从国内 CDN 解析
    external: ['three', 'three/addons/*'],
  });
  const s = await stat(path.join(ROOT, t.out));
  console.log(`  打包 ${t.entry} → ${t.out}（${(s.size / 1024).toFixed(1)} KB）`);
}
console.log('打包完成');
