import { cors, preflight, applyGroup, groupId } from '../../../lib/api-shared.js';

/**
 * POST /api/groups/:group/clear —— 清空某一组（等价于提交空数组）。
 */
export default async function handler(req, res) {
  cors(res);
  if (preflight(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const id = groupId(req.query?.group);
  try {
    const result = await applyGroup(id, {}, { clear: true });
    return res.status(result.status).json(result.ok ? result.entry : { error: result.error });
  } catch (err) {
    console.error(`POST /api/groups/${id}/clear 失败：`, err?.message || err);
    return res.status(500).json({ error: '清空失败，请稍后重试' });
  }
}