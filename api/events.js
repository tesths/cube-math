import { cors, preflight } from '../lib/api-shared.js';

/**
 * GET /api/events —— 无服务器环境不支持 SSE 长连接。
 *
 * 这里「立刻」返回 204（无响应体）并明确带上 `Cache-Control: no-store`：
 *   - EventSource 收到 204 会马上关闭，前端 net.js 随即把同步方式切到
 *     「每 2 秒轮询 GET /api/state」；
 *   - 千万不要在这里拖时间（比如等超时再返回），否则学生端要白等 2 秒才出画面。
 * 教学效果几乎无差别（老师看到的仍是秒级更新）。
 */
export default async function handler(req, res) {
  cors(res);
  if (preflight(req, res)) return;

  // 显式再声明一次：这个响应任何时候都不应被 CDN / 浏览器缓存
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-SSE-Unavailable', '1');
  res.setHeader('Retry-After', '0');

  if (req.method === 'GET' || req.method === 'HEAD') {
    return res.status(204).end();
  }
  return res.status(405).json({ error: 'method not allowed' });
}