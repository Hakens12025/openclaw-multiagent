// agent-session-store.js — agent session 摘要读路径
//
// 读 ~/.openclaw/agents/<agentId>/sessions/sessions.json（agent 会话登记表，
// 非 workspace），返回 session 摘要列表。surface inspect.agent_sessions 的源。
//
// 注意：sessions 在 agents/<agentId>/sessions/ 下，不是 agentWorkspace（workspaces/）。
// 根路径用 state-paths 的 OC 常量解析（= ~/.openclaw）。

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { OC } from "../state/state-paths.js";
import { listSessionHomes } from "../archive/session-home-index.js";

function sessionsFile(agentId) {
  return join(OC, "agents", agentId, "sessions", "sessions.json");
}

/**
 * 从 sessionKey 解析 contractId。
 * sessionKey 形如：
 *   agent:<id>:contract:tc-...      （冒号分隔）
 *   agent:<id>:...contract-<cid>... （连字符分隔，设计稿示例）
 * 取 "contract" 之后紧邻的标识符，没有则 null。
 */
export function parseContractIdFromSessionKey(sessionKey) {
  if (typeof sessionKey !== "string" || !sessionKey) return null;
  const match = sessionKey.match(/contract[:-]([^:]+)/);
  return match ? match[1] : null;
}

// 读 live sessions.json，转成摘要条目数组（文件缺失/损坏 → []）。
async function readLiveSessions(agentId) {
  let parsed;
  try {
    const raw = await readFile(sessionsFile(agentId), "utf8");
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];

  const sessions = [];
  for (const [sessionKey, value] of Object.entries(parsed)) {
    if (!value || typeof value !== "object") continue;
    sessions.push({
      sessionId: typeof value.sessionId === "string" ? value.sessionId : null,
      sessionKey,
      contractId: parseContractIdFromSessionKey(sessionKey),
      updatedAt: Number.isFinite(value.updatedAt) ? value.updatedAt : 0,
      model: typeof value.model === "string" ? value.model : null,
      totalTokens: Number.isFinite(value.totalTokens) ? value.totalTokens : null,
    });
  }
  return sessions;
}

/**
 * 读取指定 agent 的 session 摘要列表（按 updatedAt 倒序）。
 *
 * 合并 live sessions.json 条目 + session-index（run 树归档的 id→home 索引，
 * 树上 participants/{agent}/session-*.jsonl 是真值）历史条目，
 * 按 sessionId 去重（live 优先，取其 updatedAt/model/totalTokens）。
 * 这样即使 live 被 session-clean 清掉，树内归档的历史 session 仍能列出。
 *
 * 全程兜底：任一源缺失/损坏 → 当作空，不抛。
 *
 * @param {string} agentId
 * @returns {Promise<Array<{
 *   sessionId:string, sessionKey:string, contractId:string|null,
 *   updatedAt:number, model:string|null, totalTokens:number|null,
 * }>>}
 */
export async function listAgentSessions(agentId) {
  const normalizedAgentId = typeof agentId === "string" ? agentId.trim() : "";
  if (!normalizedAgentId) return [];

  const liveSessions = await readLiveSessions(normalizedAgentId);
  let archivedSessions = [];
  try {
    archivedSessions = listSessionHomes(normalizedAgentId);
  } catch {
    archivedSessions = [];
  }

  // sessionId → 条目；live 先入并占位，归档索引仅补 live 缺失的历史项。
  const bySessionId = new Map();
  for (const entry of liveSessions) {
    if (entry.sessionId) bySessionId.set(entry.sessionId, entry);
  }
  for (const archived of archivedSessions) {
    if (!archived.sessionId || bySessionId.has(archived.sessionId)) continue;
    bySessionId.set(archived.sessionId, {
      sessionId: archived.sessionId,
      sessionKey: typeof archived.sessionKey === "string" && archived.sessionKey ? archived.sessionKey : "",
      contractId: parseContractIdFromSessionKey(archived.sessionKey),
      updatedAt: Number.isFinite(archived.ts) ? archived.ts : 0,
      model: null,
      totalTokens: null,
    });
  }

  const merged = [...bySessionId.values()];
  merged.sort((a, b) => b.updatedAt - a.updatedAt);
  return merged;
}
