import { cors, preflight, applyGroup, groupId, readJsonBody } from '../../lib/api-shared.js';

/**
 * POST /api/groups/:group —— 学生端提交本组方块。
 *
 * req.query.group 在 Vercel 里是字符串（"3"），这里统一走 groupId() 转成数字；
 * 非法值（"3abc"、数组、空）会变成 NaN，由 applyGroup 统一回 404。
 */
export default async function handler(req, res) {
  cors(res);
  if (preflight(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const id = groupId(req.query?.group);
  let body = {};
  try {
    body = await readJsonBody(req);
  } catch (err) {
    if (err?.code === 'BODY_TOO_LARGE') {
      return res.status(413).json({ error: '提交的数据太大' });
    }
    return res.status(400).json({ error: 'JSON 解析失败' });
  }

  try {
    const result = await applyGroup(id, body);
    return res.status(result.status).json(result.ok ? result.entry : { error: result.error });
  } catch (err) {
    console.error(`POST /api/groups/${id} 失败：`, err?.message || err);
    return res.status(500).json({ error: '保存失败，请稍后重试' });
  }
}