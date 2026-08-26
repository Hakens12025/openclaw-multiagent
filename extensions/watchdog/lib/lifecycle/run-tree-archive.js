// run-tree-archive.js — agent session 树内归档(备忘录142 批③B,只读观测档,非第二真值)。
//
// agent_end 归档段是 participants/{agent}/session-* 成员的唯一写者:把 live 会话
// .jsonl(agents/<agentId>/sessions/<sid>.jsonl)与提示词报告 sidecar 复制进
// threads/{t}/runs/{r}/participants/{agentId}/,并向 session-home-index 登记
// sessionId→home 一行。归档落点由 trackingState.contract.lineage 决定 ——
// 无合约会话(纯 heartbeat/probe)无 run 家,不归档,跳过并 debug 留痕(批③B 裁定)。
//
// 红线:live(sessions.json + agents/<id>/sessions/<sid>.jsonl)= truth,
// 树内副本 = 历史观测档。整段 try/catch 吞错,绝不抛(归档失败不能影响 agent_end)。

import { readFile, writeFile, copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import { OC } from "../state/state-paths.js";
import { normalizeString } from "../core/normalize.js";
import { normalizeLineage } from "../contract/contract-lineage.js";
import {
  ensureRunScaffold,
  participantSessionJsonlFor,
  participantSessionPromptFor,
} from "../archive/thread-tree-store.js";
import { recordSessionHome } from "../archive/session-home-index.js";

function liveSessionsFile(agentId, root = OC) {
  return join(root, "agents", agentId, "sessions", "sessions.json");
}

function liveSessionJsonl(agentId, sessionId, root = OC) {
  return join(root, "agents", agentId, "sessions", `${sessionId}.jsonl`);
}

// 从 sessions.json 取指定 sessionKey 的 { sessionId, updatedAt, systemPromptReport }。
async function resolveLiveSession(agentId, sessionKey, root = OC) {
  let parsed;
  try {
    const raw = await readFile(liveSessionsFile(agentId, root), "utf8");
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

/**
 * 从 live 会话转录提取本轮实际执行模型(合约执行模型一等字段的观测源,2026-08-27)。
 * 取最后一条 assistant 消息的 message.model/provider —— 配置只说"想用什么",
 * 转录才说"实际用了什么"(failover 换挡后二者会分叉,以观测为准,§12 同族)。
 * 行形状(宿主会话 jsonl):{ type:"message", message:{ role:"assistant", model, provider } }。
 * 吞错返回 null:提取失败不影响 agent_end,账里缺列即"没测到"。
 *
 * @param {{ agentId?:string, sessionKey?:string, root?:string }} params
 * @returns {Promise<{ model:string, provider:string|null }|null>}
 */
export async function resolveSessionExecutionModel({ agentId, sessionKey, root = OC } = {}) {
  try {
    const aid = normalizeString(agentId);
    const key = normalizeString(sessionKey);
    if (!aid || !key) return null;
    const live = await resolveLiveSession(aid, key, root);
    if (!live?.sessionId) return null;
    const raw = await readFile(liveSessionJsonl(aid, live.sessionId, root), "utf8");
    const lines = raw.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      const message = entry?.type === "message" ? entry.message : null;
      if (message?.role === "assistant" && typeof message.model === "string" && message.model.trim()) {
        return {
          model: message.model.trim(),
          provider: normalizeString(message.provider) || null,
        };
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 把指定 agent 的当前 session 归档进其合约所在 run 树。
 * 整段 try/catch 吞错，绝不抛（归档失败不能影响 agent_end）。
 *
 * @param {{ agentId?:string, sessionKey?:string, lineage?:object|null, logger?:object|null }} params
 * @returns {Promise<{ archived:boolean, sessionId:string|null, reason?:string }>}
 */
export async function archiveSessionToRunTree({ agentId, sessionKey, lineage = null, logger = null } = {}) {
  try {
    const aid = normalizeString(agentId);
    const key = normalizeString(sessionKey);
    if (!aid || !key) return { archived: false, sessionId: null, reason: "missing_agent_or_key" };

    const home = normalizeLineage(lineage);
    if (!home?.threadId || !home?.runId) {
      // 无合约会话无 run 家,不归档(批③B 裁定;凡有合约必有谱系,缺谱系=无合约轮次)
      logger?.debug?.(`[run-tree-archive] skip ${aid}/${key}: contract-less session has no run home`);
      return { archived: false, sessionId: null, reason: "no_run_home" };
    }

    const live = await resolveLiveSession(aid, key);
    if (!live || !live.sessionId) {
      return { archived: false, sessionId: null, reason: "no_live_session" };
    }
    const { sessionId, updatedAt, systemPromptReport } = live;

    await ensureRunScaffold(home);
    const destJsonl = participantSessionJsonlFor(home, aid, sessionId);
    await mkdir(dirname(destJsonl), { recursive: true });

    // 复制 .jsonl（已存在则覆盖，保最新）。源不存在则跳过归档。
    try {
      await copyFile(liveSessionJsonl(aid, sessionId), destJsonl);
    } catch (copyError) {
      return { archived: false, sessionId, reason: `jsonl_copy_failed:${copyError?.code || "err"}` };
    }

    // 提示词报告 sidecar（若有）。单独吞错：sidecar 失败不破坏 .jsonl 归档与 agent_end。
    if (systemPromptReport) {
      try {
        await writeFile(
          participantSessionPromptFor(home, aid, sessionId),
          JSON.stringify(systemPromptReport, null, 2),
          "utf8",
        );
      } catch {
        // sidecar 写失败静默
      }
    }

    // 索引登记。单独吞错：索引可全树重建，登记失败不破坏归档主体。
    try {
      await recordSessionHome({ sessionId, sessionKey: key, agentId: aid, lineage: home, ts: updatedAt });
    } catch (indexError) {
      logger?.warn?.(`[run-tree-archive] session index record failed for ${sessionId}: ${indexError?.message || indexError}`);
    }

    return { archived: true, sessionId };
  } catch (error) {
    // 兜底：任何意外都不抛，归档失败静默
    return { archived: false, sessionId: null, reason: `error:${error?.message || error}` };
  }
}
