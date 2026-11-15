import { cors, preflight, sendState } from '../lib/api-shared.js';

/**
 * GET /api/state —— 全部小组当前状态。
 *
 * 9 台设备（8 个学生端 + 1 个教师端）降级轮询时每 2 秒打一次这个接口，
 * 所以带 ETag：客户端把 If-None-Match 带回来、数据没变就只回 304（无响应体），
 * 能明显省流量和函数执行时间。
 */
export default async function handler(req, res) {
  cors(res);
  if (preflight(req, res)) return;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return res.status(405).json({ error: 'method not allowed' });
  }
  try {
    await sendState(req, res);
  } catch (err) {
    console.error('GET /api/state 失败：', err?.message || err);
    res.status(500).json({ error: '读取状态失败，请稍后重试' });
  }
}