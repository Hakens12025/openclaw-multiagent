// api.js — 所有 HTTP 的唯一收口。组件禁止直接 fetch。
export function createApi({ token, fetchImpl = fetch }) {
  async function request(path, { method = "GET", body = null } = {}) {
    const sep = path.includes("?") ? "&" : "?";
    let res;
    try {
      res = await fetchImpl(`${path}${sep}token=${encodeURIComponent(token)}`, {
        method,
        ...(body !== null
          ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
          : {}),
      });
    } catch (e) {
      throw Object.assign(new Error(`network: ${e.message}`), { kind: "network" });
    }
    if (!res.ok) {
      throw Object.assign(new Error(`http ${res.status}`), { kind: res.status === 401 || res.status === 403 ? "auth" : "data" });
    }
    return res.json();
  }
  const getJson = (path) => request(path);
  return {
    getJson,
    postJson: (path, body) => request(path, { method: "POST", body }),
    inspect: (surface, params = {}) =>
      getJson(`/watchdog/inspect?surface=${encodeURIComponent(surface)}&${new URLSearchParams(params)}`),
    // 图编辑（连接=逻辑投递）：边是运行时路由真值，改动经 apply 端点落 agent-graph。
    graphEdgeAdd: (from, to) => request("/watchdog/graph/edge/add", { method: "POST", body: { from, to } }),
    graphEdgeDelete: (from, to) => request("/watchdog/graph/edge/delete", { method: "POST", body: { from, to } }),
  };
}

// createEventStream — SSE 唯一收口。handlers: { eventType: fn(data) }；
// 断线固定 3s 重连（MVP，旧 dashboard-sse-client 的退避曲线批后需要再移）。
export function createEventStream({
  token,
  url = "/watchdog/stream",
  EventSourceImpl = (typeof EventSource !== "undefined" ? EventSource : null),
  handlers = {},
  onStatus = null,
  retryMs = 3000,
} = {}) {
  let source = null;
  let closed = false;
  let retryTimer = null;

  function connect() {
    if (!EventSourceImpl || closed || source) return;
    onStatus?.("connecting");
    const sep = url.includes("?") ? "&" : "?";
    source = new EventSourceImpl(`${url}${sep}token=${encodeURIComponent(token)}`);
    source.onopen = () => onStatus?.("open");
    source.onerror = () => {
      try { source.close(); } catch { /* 已死连接 */ }
      source = null;
      onStatus?.("reconnecting");
      if (!closed && retryTimer == null) {
        retryTimer = setTimeout(() => { retryTimer = null; connect(); }, retryMs);
      }
    };
    for (const [type, fn] of Object.entries(handlers)) {
      source.addEventListener(type, (message) => {
        let data = null;
        try { data = JSON.parse(message.data ?? "null"); } catch { return; /* 坏帧丢弃 */ }
        fn(data);
      });
    }
  }

  connect();
  return {
    close() {
      closed = true;
      if (retryTimer != null) { clearTimeout(retryTimer); retryTimer = null; }
      if (source) { try { source.close(); } catch { /* 已死连接 */ } source = null; }
      onStatus?.("closed");
    },
  };
}
