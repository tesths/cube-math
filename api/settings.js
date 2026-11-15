import { cors, preflight, readJsonBody, readSettings, writeSettings } from '../lib/api-shared.js';
import { normalizeMode } from '../lib/store.js';

/**
 * /api/settings —— 全局设置（目前只有"显示任务0 还是 任务1·2·3"的模式）。
 *
 *   GET  → { mode: 'training' | 'formal', updatedAt }
 *   POST { mode } → 写入并返回最新设置
 *
 * 存服务器是必须的：教师在自己电脑上设置，学生平板是另一台设备，
 * 只写 localStorage 传不过去。学生端启动时读这里决定显示哪些任务。
 */
export default async function handler(req, res) {
  cors(res);
  if (preflight(req, res)) return;

  if (req.method === 'GET' || req.method === 'HEAD') {
    try {
      return res.status(200).json(await readSettings());
    } catch (err) {
      console.error('GET /api/settings 失败：', err?.message || err);
      return res.status(500).json({ error: '读取设置失败' });
    }
  }

  if (req.method === 'POST') {
    let body = {};
    try {
      body = await readJsonBody(req);
    } catch (err) {
      if (err?.code === 'BODY_TOO_LARGE') return res.status(413).json({ error: '提交的数据太大' });
      return res.status(400).json({ error: 'JSON 解析失败' });
    }
    if (body?.mode !== 'training' && body?.mode !== 'formal') {
      return res.status(400).json({ error: "mode 只能是 'training' 或 'formal'" });
    }
    try {
      const next = await writeSettings(normalizeMode(body.mode));
      return res.status(200).json(next);
    } catch (err) {
      console.error('POST /api/settings 失败：', err?.message || err);
      return res.status(500).json({ error: '保存设置失败' });
    }
  }

  return res.status(405).json({ error: 'method not allowed' });
}
