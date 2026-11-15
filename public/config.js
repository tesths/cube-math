/**
 * 运行时配置（部署后可以直接改这个文件，不用重新构建）。
 *
 * apiBase 留空 = 与页面同源：
 *   - Railway / 自己服务器部署整套应用 → 保持空
 *   - Vercel 部署整套应用（配了 Redis）→ 保持空
 *   - 前端放 Vercel、后端放 Railway → 填后端的地址，例如：
 *       window.CUBE_VIEWS_CONFIG = { apiBase: 'https://cube-views.up.railway.app' };
 *
 * pollMs：只有"拿不到 SSE 长连接"时才轮询（Vercel 就是这种情况）。
 *   默认 1000 毫秒（老师要求"1 秒同步一次"，界面也不再显示"慢速同步"）。
 *   如果 Upstash 命令数紧张，可以调大到 2000~5000，代价是更新晚 1~4 秒。
 */
window.CUBE_VIEWS_CONFIG = {
  apiBase: '',
  pollMs: 1000,
  // 设置页的教师口令（教师端「设置」进 /settings 时输入）。学生不知道就进不去。
  // 这是纯前端口令门，用来挡住学生误入，不是强安全；需要就改这里，部署后即时生效。
  settingsPin: '8888',
};
