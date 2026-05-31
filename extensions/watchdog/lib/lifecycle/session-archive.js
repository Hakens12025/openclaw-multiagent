// session-archive.js — agent session 持久归档（只读观测档，非第二真值）
//
// 背景：agents/<agentId>/sessions/sessions.json 每 agent 只存「当前 1 个」
// session（sessionKey→1 sessionId，原地更新，无历史），且测试 session-clean
// 会清掉。故「工作流」页只能看到当前还在的 session（如 controller）。
//
// 本归档在 agent_end 时把会话 .jsonl 复制到
//   control-plane/session-archive/<agentId>/<sessionId>.jsonl
// 并维护 index.json（按 sessionId 去重的历史列表），供页面观测历史 session。
//
// 红线：live（sessions.json + agents/<id>/sessions/<sid>.jsonl）= truth，
// archive = 历史副本，不造第二真值。整段 try/catch 吞错，绝不抛
// （归档失败不能影响 agent_end）。

import { readFile, writeFile, copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { OC } from "../state-paths.js";
import { CONTROL_PLANE_PATHS } from "../control-plane/control-plane-paths.js";

const ARCHIVE_ROOT = join(CONTROL_PLANE_PATHS.root, "session-archive");

function liveSessionsFile(agentId) {
  return join(OC, "agents", agentId, "sessions", "sessions.json");
}

function liveSessionJsonl(agentId, sessionId) {
  return join(OC, "agents", agentId, "sessions", `${sessionId}.jsonl`);
}

export function archiveAgentDir(agentId) {
  return join(ARCHIVE_ROOT, agentId);
}

export function archiveIndexFile(agentId) {
  return join(ARCHIVE_ROOT, agentId, "index.json");
}

export function archiveSessionJsonl(agentId, sessionId) {
  return join(ARCHIVE_ROOT, agentId, `${sessionId}.jsonl`);
}

// 系统提示词拼装报告归档 sidecar（让历史 session 的提示词也可看）。
export function archiveSessionPromptFile(agentId, sessionId) {
  return join(ARCHIVE_ROOT, agentId, `${sessionId}.prompt.json`);
}

// 从 sessions.json 取指定 sessionKey 的 { sessionId, updatedAt, systemPromptReport }。
async function resolveLiveSession(agentId, sessionKey) {
  let parsed;
  try {
    const raw = await readFile(liveSessionsFile(agentId), "utf8");
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const entry = parsed[sessionKey];
  if (entry && typeof entry === "object" && typeof entry.sessionId === "string") {
    return {
      sessionId: entry.sessionId,
      updatedAt: Number.isFinite(entry.updatedAt) ? entry.updatedAt : 0,
      systemPromptReport: entry.systemPromptReport && typeof entry.systemPromptReport === "object"
        ? entry.systemPromptReport
        : null,
    };
  }
  return null;
}

async function readArchiveIndex(agentId) {
  try {
    const raw = await readFile(archiveIndexFile(agentId), "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * 把指定 agent 的当前 session 归档到 control-plane/session-archive/。
 * 整段 try/catch 吞错，绝不抛（归档失败不能影响 agent_end）。
 *
 * @param {{ agentId?:string, sessionKey?:string, contractId?:string|null }} params
 * @returns {Promise<{ archived:boolean, sessionId:string|null, reason?:string }>}
 */
export async function archiveAgentSession({ agentId, sessionKey, contractId = null } = {}) {
  try {
    const aid = typeof agentId === "string" ? agentId.trim() : "";
    const key = typeof sessionKey === "string" ? sessionKey.trim() : "";
    if (!aid || !key) return { archived: false, sessionId: null, reason: "missing_agent_or_key" };

    const live = await resolveLiveSession(aid, key);
    if (!live || !live.sessionId) {
      return { archived: false, sessionId: null, reason: "no_live_session" };
    }
    const { sessionId, updatedAt, systemPromptReport } = live;

    // 复制 .jsonl（已存在则覆盖，保最新）。源不存在则跳过归档。
    await mkdir(archiveAgentDir(aid), { recursive: true });
    try {
      await copyFile(liveSessionJsonl(aid, sessionId), archiveSessionJsonl(aid, sessionId));
    } catch (copyError) {
      return { archived: false, sessionId, reason: `jsonl_copy_failed:${copyError?.code || "err"}` };
    }

    // 归档 systemPromptReport sidecar（若有），让历史 session 的提示词拼装也可看。
    // 单独 try/catch 吞错：sidecar 写失败不破坏 .jsonl/index 归档与 agent_end。
    if (systemPromptReport) {
      try {
        await writeFile(
          archiveSessionPromptFile(aid, sessionId),
          JSON.stringify(systemPromptReport, null, 2),
          "utf8",
        );
      } catch {
        // sidecar 写失败静默
      }
    }

    // 维护 index.json：按 sessionId 去重，更新已有项，保留历史项。
    // archivedAt 用 sessions.json 的 updatedAt（测试可复现，不用 Date.now）。
    const index = await readArchiveIndex(aid);
    const normalizedContractId = typeof contractId === "string" && contractId.trim()
      ? contractId.trim()
      : null;
    const existing = index.find((item) => item && item.sessionId === sessionId);
    if (existing) {
      existing.sessionKey = key;
      existing.contractId = normalizedContractId;
      existing.updatedAt = updatedAt;
      existing.archivedAt = updatedAt;
    } else {
      index.push({
        sessionId,
        sessionKey: key,
        contractId: normalizedContractId,
        updatedAt,
        archivedAt: updatedAt,
      });
    }
    await writeFile(archiveIndexFile(aid), JSON.stringify(index, null, 2), "utf8");

    return { archived: true, sessionId };
  } catch (error) {
    // 兜底：任何意外都不抛，归档失败静默
    return { archived: false, sessionId: null, reason: `error:${error?.message || error}` };
  }
}

/**
 * 读取指定 agent 的归档 index 条目（供 listAgentSessions 合并）。
 * 不存在 / 解析失败 → []。
 *
 * @param {string} agentId
 * @returns {Promise<Array<{sessionId,sessionKey,contractId,updatedAt,archivedAt}>>}
 */
export async function listArchivedSessions(agentId) {
  const aid = typeof agentId === "string" ? agentId.trim() : "";
  if (!aid) return [];
  const index = await readArchiveIndex(aid);
  return index.filter((item) => item && typeof item === "object" && typeof item.sessionId === "string");
}
