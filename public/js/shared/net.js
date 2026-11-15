/**
 * 与服务器通信：SSE 接收实时状态、轮询兜底、提交本组方块。
 * 浏览器端专用（ESM）。
 *
 * 默认与页面同源。前后端分开部署时（前端在 Vercel、后端在 Railway），
 * 在 public/config.js 里填 apiBase，或临时用 ?api=https://xxx 覆盖。
 *
 * 两种链路：
 *   - 有 SSE（本地 / Railway）：收到即更新，秒级。
 *   - 没有 SSE（Vercel 等无服务器平台）：自动降级为轮询 + ETag/304，2 秒一次。
 */

/** 解析后端地址：?api= 查询参数 > config.js 的 apiBase > 同源 */
function resolveApiBase() {
  const fromConfig = globalThis.CUBE_VIEWS_CONFIG?.apiBase;
  const fromQuery = new URLSearchParams(location.search).get('api');
  const base = (fromQuery || fromConfig || '').trim();
  return base.replace(/\/$/, '');
}

const API_BASE = resolveApiBase();

function apiUrl(path) {
  return `${API_BASE}${path}`;
}

/** 连续多久收不到 SSE 数据就判定"这个部署不支持长连接" */
const SSE_FIRST_PACKET_MS = 3000;
/** 判定不支持之后，隔多久再试一次（局域网服务器重启后能自己恢复实时推送） */
const SSE_RETRY_MS = 30000;

export function openStateStream({ onState, onStatus } = {}) {
  let closed = false;
  let source = null;
  let pollTimer = null;
  let sseRetryTimer = null;
  let firstPacketTimer = null;
  let gotSseState = false;      // 是否真的收到过 SSE 数据（'open' 不算）
  let lastEventAt = 0;
  let etag = null;              // 上一次 /api/state 的 ETag
  let lastState = null;         // 上一次的完整状态；收到 304 时直接复用
  const pollMs = Math.max(1000, Number(globalThis.CUBE_VIEWS_CONFIG?.pollMs) || 2000);

  const emitStatus = (status, detail) => onStatus?.(status, detail);

  // ------------------------------------------------------------------ 轮询

  async function pollOnce() {
    // 页面在后台时不轮询：省流量，也省 Redis 命令数（免费额度有限）
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    try {
      const res = await fetch(apiUrl('/api/state'), {
        cache: 'no-store',
        headers: etag ? { 'If-None-Match': etag } : undefined,
      });

      // 304 表示数据没变。注意 res.ok 对 304 是 false，必须单独判断，
      // 否则会把"一切正常"误判成"连接断开"。
      if (res.status === 304) {
        if (lastState) onState?.(lastState);
        emitStatus('polling');
        return;
      }

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const nextEtag = res.headers.get('ETag');
      if (nextEtag) etag = nextEtag;
      lastState = await res.json();
      onState?.(lastState);
      emitStatus('polling');
    } catch (err) {
      emitStatus('offline', err.message);
    }
  }

  function startPolling() {
    if (pollTimer || closed) return;
    pollOnce();
    pollTimer = setInterval(pollOnce, pollMs);
  }

  function stopPolling() {
    if (!pollTimer) return;
    clearInterval(pollTimer);
    pollTimer = null;
  }

  // ------------------------------------------------------------------ SSE

  /** 判定这个部署不支持长连接：改轮询，并隔一段时间再试一次 */
  function fallBackToPolling() {
    if (closed) return;
    clearTimeout(firstPacketTimer);
    source?.close();
    source = null;
    if (!pollTimer) emitStatus('polling');
    startPolling();
    clearTimeout(sseRetryTimer);
    sseRetryTimer = setTimeout(connectSse, SSE_RETRY_MS);
  }

  function connectSse() {
    if (closed) return;
    emitStatus('connecting');
    source = new EventSource(apiUrl('/api/events'));

    // 'open' 只代表 HTTP 连接建立了，不代表平台真的会推数据
    // （Vercel 上我们会拿到 204，或者一个永不推流的响应）。
    // 所以以"收到第一条 state"为准，超时就降级。
    firstPacketTimer = setTimeout(() => {
      if (!gotSseState) fallBackToPolling();
    }, SSE_FIRST_PACKET_MS);

    source.addEventListener('state', (event) => {
      gotSseState = true;
      lastEventAt = Date.now();
      clearTimeout(firstPacketTimer);
      clearTimeout(sseRetryTimer);
      stopPolling();
      emitStatus('live');
      try {
        onState?.(JSON.parse(event.data));
      } catch {
        /* 忽略坏包，等下一次推送 */
      }
    });

    source.addEventListener('error', () => {
      clearTimeout(firstPacketTimer);
      if (!gotSseState) {
        // 从来没收到过数据：基本可以确定不支持长连接
        fallBackToPolling();
        return;
      }
      // 收到过数据、现在断了：多半是临时抖动，EventSource 会自己重连，
      // 同时开轮询兜底，避免长时间收不到数据。
      emitStatus('reconnecting');
      startPolling();
    });
  }

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && pollTimer) pollOnce();
    });
  }

  connectSse();

  return {
    close() {
      closed = true;
      stopPolling();
      clearTimeout(firstPacketTimer);
      clearTimeout(sseRetryTimer);
      source?.close();
    },
    get lastEventAt() { return lastEventAt; },
  };
}

/** 提交某组的方块列表（数组 [[x,y,z], ...]）。失败会抛出带服务端说明的错误。 */
export async function saveGroup(group, cubes, task) {
  const res = await fetch(apiUrl(`/api/groups/${group}`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cubes, task }),
  });
  if (!res.ok) {
    let message = `保存失败（HTTP ${res.status}）`;
    try {
      const body = await res.json();
      if (body?.error) message = body.error;
    } catch { /* 保留默认信息 */ }
    throw new Error(message);
  }
  return res.json();
}

/**
 * 页面关闭/切走时的最后一次保存。
 *
 * 不能用 `navigator.sendBeacon(同源地址, application/json)`：配置了 apiBase 时它打不到后端，
 * 而且跨域的 application/json beacon 会被 CORS 拒绝。这里用 keepalive fetch（支持跨域），
 * 失败再退回 text/plain 的 beacon（后端照样按 JSON 解析）。
 */
export function saveGroupBeacon(group, cubes, task) {
  const url = apiUrl(`/api/groups/${group}`);
  const body = JSON.stringify({ cubes, task });
  const fallback = () => {
    try {
      navigator.sendBeacon?.(url, new Blob([body], { type: 'text/plain;charset=UTF-8' }));
    } catch { /* 尽力而为 */ }
  };
  try {
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
    }).catch(fallback);
  } catch {
    fallback();
  }
}

/** 拉一次全量状态（页面初始化时用，不依赖 SSE 是否立刻连通）。 */
export async function fetchState() {
  const res = await fetch(apiUrl('/api/state'), { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
