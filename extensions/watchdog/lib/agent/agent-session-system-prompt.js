// agent-session-system-prompt.js — session 系统提示词拼装报告读路径
//
// 框架在 sessions.json 的 entry.systemPromptReport 里写下「系统提示词如何拼装」
// 的真值（注入文件、skills、tools、systemPrompt 字符统计、bootstrap 上限等）。
// 「工作流」页点输入气泡时读它，看提示词拼装细节。surface
// inspect.session_system_prompt 的源。
//
// 只读观测：systemPromptReport 是框架写的真值，我们只投影 + 给每个注入文件
// 按 path 读取正文（content），让前端能拼成「组合型系统提示词」正文直接渲染。
// 不造第二真值。
//
// 优先级：
//   ① live sessions.json 的 systemPromptReport（精确报告，source 用报告里的）
//   ② 归档 sidecar control-plane/session-archive/<agentId>/<sessionId>.prompt.json
//   ③ 兜底重建：前两者都没有时（中继 agent 的 sessions.json 不写
//      systemPromptReport），从该 agent 工作区按 framework 固定注入清单重建
//      拼装视图，source="reconstructed"，前端可据此标注「由工作区文件重建」。
//
// 两条路径都按 injectedFiles[i].path 读取正文填进 content（精确报告本身不存
// 正文）；单文件上限 CAP=40000 字符，超出截断 + truncated:true。

import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { OC } from "../state-paths.js";
import { CONTROL_PLANE_PATHS } from "../control-plane/control-plane-paths.js";
import { agentWorkspace } from "../state-agent-helpers.js";
import { listAgentSessions, parseContractIdFromSessionKey } from "./agent-session-store.js";
import { getAgentRole } from "./agent-identity.js";
import {
  shouldOverrideContractSessionPrompt,
  buildContractSessionSystemPrompt,
} from "../contract-session-prompt-override.js";
import { loadOpenClawConfig } from "../capability/capability-registry.js";
import { composeEffectiveProfile } from "../effective-profile-composer.js";

// 从 AgentBinding/config 取该 agent 的 effective 工具 + 技能（配置范围）。
// 合约会话 / 中继 agent 没有框架 systemPromptReport（框架仍按 binding 注入工具技能，只是没记字数），
// 故从 binding 取真实范围补进装配视图，标 fromBinding（无精确字数）。缺 config / 不抛。
async function resolveAgentBindingCapabilities(agentId) {
  try {
    const config = await loadOpenClawConfig();
    const list = Array.isArray(config?.agents?.list) ? config.agents.list : [];
    const agentConfig = list.find((a) => (typeof a?.id === "string" ? a.id.trim() : "") === agentId);
    if (!agentConfig) return null;
    const profile = composeEffectiveProfile({ config, agentConfig });
    const tools = Array.isArray(profile?.capabilities?.tools) ? profile.capabilities.tools : [];
    const skills = Array.isArray(profile?.effectiveSkills) ? profile.effectiveSkills : [];
    if (tools.length === 0 && skills.length === 0) return null;
    return { tools, skills };
  } catch {
    return null;
  }
}

// skill 的 head：SKILL.md frontmatter（--- … ---）—— 这正是注入上下文的描述/元数据来源
// （全文由 agent 判断适用后按需 read，见传送带 progressive disclosure）。读不到 → null。
const SKILL_HEAD_CAP = 4000;
async function readSkillHead(skillId) {
  try {
    const raw = await readFile(join(OC, "skills", skillId, "SKILL.md"), "utf8");
    const m = raw.match(/^---\n[\s\S]*?\n---/);
    const head = m ? m[0] : raw.slice(0, 600);
    return head.length > SKILL_HEAD_CAP ? head.slice(0, SKILL_HEAD_CAP) : head;
  } catch {
    return null;
  }
}

// 为一组 skill id 读各自的 head，返回 { <id>: <head文本> } 映射（读不到的跳过）。
async function buildSkillHeads(skillIds) {
  const ids = [...new Set((skillIds || []).filter((s) => typeof s === "string" && s))];
  const heads = {};
  // 并行读各 skill 的 head（彼此独立），避免 N 次串行读盘。
  const results = await Promise.all(ids.map((id) => readSkillHead(id)));
  ids.forEach((id, i) => { if (results[i]) heads[id] = results[i]; });
  return heads;
}

// 单注入文件正文上限（字符）。超出本层截断，truncated 标记「内容是否被本层截断」。
const CONTENT_CAP = 40000;

// 系统提示词分两路（互斥，由 sessionKey 决定，二者不同时进上下文）：
//   - 用户直连 / main 会话 → openclaw 类型（SOUL 系列：精确报告或工作区重建）
//   - 系统内部派工 / 合约会话 → 系统内部提示词（agent-awake：before_prompt_build 覆盖 SOUL）
// 框架基础提示词 + 工具 schema 是第三层，任何会话都在，叠在上面这二选一之上（插件拿不到其正文）。

// 解析 sessionId → sessionKey（live + archive 合并）。
async function resolveSessionKey(agentId, sessionId) {
  try {
    const sessions = await listAgentSessions(agentId);
    return sessions.find((s) => s.sessionId === sessionId)?.sessionKey || "";
  } catch {
    return "";
  }
}

// agent-awake 视图（系统内部提示词）：用 buildContractSessionSystemPrompt 按角色生成。
// contractId 取自 sessionKey（无则用 example 占位，仅用于「展示这一模式长什么样」）。
async function buildAgentAwakeView(agentId, sessionKey) {
  try {
    const contractId = parseContractIdFromSessionKey(sessionKey) || "example";
    const synthKey = `agent:${agentId}:contract:${contractId}`;
    if (!shouldOverrideContractSessionPrompt({ agentId, sessionKey: synthKey })) {
      return { available: false };
    }
    const prompt = await buildContractSessionSystemPrompt({
      agentId,
      role: getAgentRole(agentId),
      sessionKey: synthKey,
    });
    if (typeof prompt !== "string" || !prompt) return { available: false };

    const truncated = prompt.length > CONTENT_CAP;
    const content = truncated ? prompt.slice(0, CONTENT_CAP) : prompt;
    return {
      available: true,
      source: "contract-session-override",
      report: { systemPrompt: { chars: prompt.length } },
      injectedFiles: [{
        name: "agent-awake（系统内部提示词）",
        path: null,
        content,
        contentChars: content.length,
        persistent: true,
        truncated,
      }],
      totalContentChars: content.length,
    };
  } catch {
    return { available: false };
  }
}

// SOUL 视图（openclaw 类型）：精确报告（live/归档）优先，否则从工作区文件重建。
async function buildSoulView(agentId, sessionId) {
  const report = (await readLiveReport(agentId, sessionId)) || (await readArchivedReport(agentId, sessionId));
  if (report) {
    const injectedFiles = await buildInjectedFilesFromReport(report);
    return {
      available: true,
      source: typeof report.source === "string" ? report.source : null,
      report,
      injectedFiles,
      totalContentChars: sumContentChars(injectedFiles),
    };
  }
  const reconstructed = await reconstructFromWorkspace(agentId);
  if (reconstructed) {
    return { ...reconstructed, totalContentChars: sumContentChars(reconstructed.injectedFiles) };
  }
  return { available: false };
}

function liveSessionsFile(agentId) {
  return join(OC, "agents", agentId, "sessions", "sessions.json");
}

function archivedPromptFile(agentId, sessionId) {
  return join(CONTROL_PLANE_PATHS.root, "session-archive", agentId, `${sessionId}.prompt.json`);
}

// live 中按 sessionId 匹配（遍历所有 sessionKey 条目），命中则返回 systemPromptReport。
async function readLiveReport(agentId, sessionId) {
  let parsed;
  try {
    const raw = await readFile(liveSessionsFile(agentId), "utf8");
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  for (const entry of Object.values(parsed)) {
    if (entry && typeof entry === "object" && entry.sessionId === sessionId) {
      const report = entry.systemPromptReport;
      if (report && typeof report === "object") return report;
      return null;
    }
  }
  return null;
}

// 回退读归档 sidecar（live 被清后）。
async function readArchivedReport(agentId, sessionId) {
  try {
    const raw = await readFile(archivedPromptFile(agentId, sessionId), "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// 按 path 读取注入文件正文，补 content/contentChars/persistent/truncated。
// 读失败（不存在/权限）→ content:null、persistent:false、contentChars:0（不抛）。
// 超 CONTENT_CAP → content=slice(0,CAP) + truncated:true（覆盖原 truncated，
// 表示「内容是否被本层截断」）。base 用于带上报告/重建的原始字段。
async function attachFileContent(path, base = {}) {
  const filePath = typeof path === "string" ? path : "";
  if (!filePath) {
    return { ...base, path: filePath, content: null, contentChars: 0, persistent: false, truncated: false };
  }
  let raw;
  try {
    raw = await readFile(filePath, "utf8");
  } catch {
    return { ...base, path: filePath, content: null, contentChars: 0, persistent: false, truncated: false };
  }
  const truncated = raw.length > CONTENT_CAP;
  const content = truncated ? raw.slice(0, CONTENT_CAP) : raw;
  return {
    ...base,
    path: filePath,
    content,
    contentChars: content.length,
    persistent: true,
    truncated,
  };
}

// 精确报告路径：报告的 injectedWorkspaceFiles 有 path 但不存正文，
// 按 path 读 content 填进去（保留报告原字段如 name/rawChars/injectedChars/missing）。
async function buildInjectedFilesFromReport(report) {
  const files = Array.isArray(report?.injectedWorkspaceFiles) ? report.injectedWorkspaceFiles : [];
  return Promise.all(files.map((file) => attachFileContent(file?.path, file)));
}

// framework 自动注入的工作区根文件固定清单（存在才计入）。
const RECONSTRUCT_ROOT_FILES = Object.freeze([
  "AGENTS.md",
  "SOUL.md",
  "TOOLS.md",
  "IDENTITY.md",
  "USER.md",
  "HEARTBEAT.md",
  "BOOTSTRAP.md",
]);

// 重建路径单文件：读正文（attachFileContent 含上限/截断）+ 补 rawChars/injectedChars。
// 文件不存在/读失败（content:null）→ 返回 null（跳过，不计入重建清单）。
async function readReconstructedFile(path, name) {
  const withContent = await attachFileContent(path, { name });
  if (withContent.content == null) return null;
  return {
    ...withContent,
    rawChars: withContent.contentChars,
    injectedChars: withContent.contentChars, // best-effort：无法还原裁剪逻辑，取读到的字符数
  };
}

// 兜底重建：从 agent 工作区按固定清单 + memory/*.md 重建拼装视图。
// 无 systemPromptReport（中继 agent）时让每个 agent 都能看提示词来源。
async function reconstructFromWorkspace(agentId) {
  let workspaceDir;
  try {
    workspaceDir = agentWorkspace(agentId);
  } catch {
    return null;
  }
  if (!workspaceDir || !existsSync(workspaceDir)) return null;

  const injectedFiles = [];

  // 工作区根固定清单
  for (const name of RECONSTRUCT_ROOT_FILES) {
    const file = await readReconstructedFile(join(workspaceDir, name), name);
    if (file) injectedFiles.push(file);
  }

  // memory/*.md（若有 memory 目录）
  const memoryDir = join(workspaceDir, "memory");
  if (existsSync(memoryDir)) {
    let entries = [];
    try {
      entries = await readdir(memoryDir);
    } catch {
      entries = [];
    }
    for (const entry of entries.filter((e) => e.toLowerCase().endsWith(".md")).sort()) {
      const file = await readReconstructedFile(join(memoryDir, entry), join("memory", entry));
      if (file) injectedFiles.push(file);
    }
  }

  if (injectedFiles.length === 0) return null;

  const totalChars = injectedFiles.reduce((sum, f) => sum + f.rawChars, 0);
  return {
    available: true,
    source: "reconstructed",
    report: {
      workspaceDir,
      systemPrompt: { chars: totalChars },
      skills: [],
      tools: [],
    },
    injectedFiles,
  };
}

// 各文件 content 字符之和（content:null 计 0）。
function sumContentChars(injectedFiles) {
  return injectedFiles.reduce(
    (sum, f) => sum + (Number.isFinite(f?.contentChars) ? f.contentChars : 0),
    0,
  );
}

/**
 * 读取指定 agent/session 的系统提示词拼装报告。
 *
 * 优先级：① live systemPromptReport ② 归档 sidecar ③ 工作区重建。
 * 三者皆无 → { available:false }（不抛）。
 *
 * source：①② 用报告里的 source（如 "run"）；③ 固定为 "reconstructed"。
 *
 * 每个 injectedFiles[i] 带 content（按 path 读取的正文，单文件上限 CONTENT_CAP，
 * 超出截断 + truncated:true；读不到 content:null）+ contentChars；顶层带
 * totalContentChars（各文件 content 字符之和），保留 report（含 systemPrompt
 * 字符分解，供前端说明「框架另加基础提示/工具」）。
 *
 * @param {string} agentId
 * @param {string} sessionId
 * @returns {Promise<
 *   { available:false } |
 *   { available:true, source:string|null, report:object,
 *     injectedFiles:Array<object>, totalContentChars:number }
 * >}
 */
export async function readSessionSystemPrompt(agentId, sessionId) {
  const aid = typeof agentId === "string" ? agentId.trim() : "";
  const sid = typeof sessionId === "string" ? sessionId.trim() : "";
  if (!aid || !sid) return { available: false };

  // 本 session 实际走哪条路（互斥）：sessionKey 是合约会话 → 系统派工(agent-awake)；否则 → 用户直连(SOUL)
  const sessionKey = await resolveSessionKey(aid, sid);
  const isDispatch = Boolean(sessionKey) && shouldOverrideContractSessionPrompt({ agentId: aid, sessionKey });
  const activePath = isDispatch ? "dispatch-agent-awake" : "direct-soul";

  // 三者彼此独立，并行构建：两种视图(供前端双按钮对比) + binding 工具/技能范围。
  const [soulView, agentAwakeView, bindingCapabilities] = await Promise.all([
    buildSoulView(aid, sid),
    buildAgentAwakeView(aid, sessionKey),
    resolveAgentBindingCapabilities(aid),
  ]);

  const active = isDispatch ? agentAwakeView : soulView;
  if (!active || active.available !== true) return { available: false };

  // 收集涉及的 skill id（binding + 报告），读各自 head 供页面逐个展开（agent 读到的内容）。
  const skillIdSet = new Set();
  (bindingCapabilities?.skills || []).forEach((s) => skillIdSet.add(s));
  const soulSkillEntries = soulView?.report?.skills?.entries;
  if (Array.isArray(soulSkillEntries)) {
    soulSkillEntries.forEach((e) => skillIdSet.add((e && (e.id || e.name)) || e));
  }
  const skillHeads = await buildSkillHeads([...skillIdSet]);

  // 顶层 = active 视图（向后兼容既有消费者）；另加 activePath + 两路视图 + binding 范围 + skill heads。
  return {
    ...active,
    activePath,
    views: {
      soul: soulView.available ? soulView : null,
      agentAwake: agentAwakeView.available ? agentAwakeView : null,
    },
    ...(bindingCapabilities ? { bindingCapabilities } : {}),
    ...(Object.keys(skillHeads).length ? { skillHeads } : {}),
  };
}
