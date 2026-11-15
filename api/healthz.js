import { GROUP_COUNT, storeKind } from '../lib/store.js';
import { cors, preflight } from '../lib/api-shared.js';

/**
 * GET /api/healthz —— 轻量健康检查（Vercel 部署后验证 / 监控探活用）。
 *
 * 刻意不碰存储：不查 Redis、不算 ETag，纯内存常量，冷启动后也只需几毫秒，
 * 这样它既能验证「函数本身活着」，又不会因为 Redis 慢而误报。
 */
export default async function handler(req, res) {
  cors(res);
  if (preflight(req, res)) return;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return res.status(405).json({ error: 'method not allowed' });
  }

  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({
    ok: true,
    groups: GROUP_COUNT,
    // Vercel 会注入实际执行区域（例如 hkg1），方便确认有没有走香港
    region: process.env.VERCEL_REGION || null,
    // 当前用的是哪种存储：redis=多实例共享；memory=没配 Redis（多实例不同步，仅单实例可用）
    store: storeKind(),
    time: Date.now(),
  });
}