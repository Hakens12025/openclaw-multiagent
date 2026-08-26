// execution-trace-store.js — 退役垫片(spec §9)。
//
// 内存 Map、期望提取、哈希链与 evaluateTrace 判定已整体并入证据面:
// 事实投影 → lib/evidence/session-progress-projection.js(同步、热路径可读)
// 全保真事件 → lib/evidence/session-trace-store.js(异步 jsonl 账本)
//
// 本文件只剩两个域外调用点的导入路径:lib/admin/runtime-admin.js 与
// lib/lifecycle/agent-end/stage-definitions.js。把这两处改成直接从
// session-progress-projection.js 导入 clearSessionProgress /
// clearAllSessionProgress 之后,本文件即可删除。

export {
  clearSessionProgress as clearTrace,
  clearAllSessionProgress as clearAllTraces,
} from "../evidence/session-progress-projection.js";
