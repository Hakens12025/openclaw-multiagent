// router.js — hash 路由。parseHash 纯函数：hash → { zone, params }。
// 三区：#/ 指挥台、#/inspect 透视、#/manage/<sub> 管理。query 段并入 params。
const ZONES = new Set(["command", "inspect", "manage"]);

export function parseHash(hash) {
  const raw = String(hash || "").replace(/^#/, "");
  const [pathPart, queryPart = ""] = raw.split("?");
  const segments = pathPart.split("/").filter(Boolean);
  const zone = ZONES.has(segments[0]) ? segments[0] : "command";
  const params = Object.fromEntries(new URLSearchParams(queryPart));
  if (zone === "manage" && segments[1]) params.sub = segments[1];
  return { zone, params };
}

// startRouter(onChange)：监听 hashchange，首帧即回调一次。返回停止函数。
export function startRouter(onChange, { windowImpl = window } = {}) {
  const emitChange = () => onChange(parseHash(windowImpl.location.hash));
  windowImpl.addEventListener("hashchange", emitChange);
  emitChange();
  return () => windowImpl.removeEventListener("hashchange", emitChange);
}
