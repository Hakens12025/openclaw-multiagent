/**
 * session-system-prompt.test.js — session 系统提示词拼装报告读路径 + 归档 sidecar
 *
 * 覆盖：
 *   1. readSessionSystemPrompt：live 命中（按 sessionId 匹配 sessions.json）
 *   2. readSessionSystemPrompt：live 被清 → 回退树内归档 sidecar（经 session-index 找家）
 *   3. readSessionSystemPrompt：两处皆无 / 缺参 → { available:false } 兜底
 *   4. injectedFiles 补 persistent（existsSync）：存在文件 true、缺失文件 false
 *   5. archiveSessionToRunTree：写树内 session-<sid>.prompt.json sidecar（report 有则写）
 *   6. surface inspect.session_system_prompt 合规 + 经 surface 等价
 *   7. 兜底重建：无 systemPromptReport 的 agent → 从工作区文件重建（source:"reconstructed"）
 *   8. injectedFiles 补 content（两路径按 path 读正文）+ 上限截断 + 读不到 content:null
 *
 * report 是框架写的真值，比较直接对照（无时间戳 race；archivedAt 等不涉本路径）。
 * fixtures 写到 ~/.openclaw 下唯一命名目录，finally 清理。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { readSessionSystemPrompt } from "../lib/agent/agent-session-system-prompt.js";
import { archiveSessionToRunTree } from "../lib/lifecycle/run-tree-archive.js";
import { resolveThreadsRoot } from "../lib/archive/thread-tree-store.js";
import {
  inspectCliSystemSurface,
  getCliSystemSurface,
} from "../lib/cli-system/cli-surface-registry.js";
import { validateCliSurface } from "../lib/cli-system/cli-surface-schema.js";

const OC_ROOT = join(homedir(), ".openclaw");

function liveSessionsDir(agentId) {
  return join(OC_ROOT, "agents", agentId, "sessions");
}

function participantDir(lineage, agentId) {
  return join(resolveThreadsRoot(), lineage.threadId, "runs", lineage.runId, "participants", agentId);
}

// 构造一个含 systemPromptReport 的 report（注入文件含一个存在、一个缺失）
function buildReport(agentId, { existingPath, missingPath }) {
  return {
    source: "test",
    sessionId: "sid-sp",
    workspaceDir: `/Users/x/.openclaw/workspaces/${agentId}`,
    bootstrapMaxChars: 4000,
    systemPrompt: { chars: 100, projectContextChars: 40, nonProjectContextChars: 60 },
    injectedWorkspaceFiles: [
      { name: "AGENTS.md", path: existingPath, missing: false, rawChars: 10, injectedChars: 10, truncated: false },
      { name: "GONE.md", path: missingPath, missing: true, rawChars: 0, injectedChars: 0, truncated: false },
    ],
    skills: { promptChars: 1, entries: [] },
    tools: { listChars: 1, schemaChars: 1, entries: [] },
  };
}

async function writeLiveSession(agentId, { sessionKey, sessionId, report = null }) {
  const dir = liveSessionsDir(agentId);
  await mkdir(dir, { recursive: true });
  const entry = { sessionId, updatedAt: 123, model: "m1", totalTokens: 5 };
  if (report) entry.systemPromptReport = report;
  await writeFile(join(dir, "sessions.json"), JSON.stringify({ [sessionKey]: entry }), "utf8");
  // .jsonl（归档复制需要）
  await writeFile(join(dir, `${sessionId}.jsonl`),
    JSON.stringify({ type: "message", message: { role: "user", content: "hi" } }), "utf8");
}

async function cleanupAgent(agentId, lineage = null) {
  await rm(join(OC_ROOT, "agents", agentId), { recursive: true, force: true });
  if (lineage?.threadId) {
    await rm(join(resolveThreadsRoot(), lineage.threadId), { recursive: true, force: true });
  }
}

// ── 1 + 4. live 命中 + injectedFiles 补 persistent ────────────────────────────

test("readSessionSystemPrompt：live 命中（按 sessionId 匹配），injectedFiles 补 persistent", async () => {
  const agentId = `__sp_live_${Date.now()}__`;
  const dir = liveSessionsDir(agentId);
  await mkdir(dir, { recursive: true });
  // 用一个真实存在的文件路径做 persistent=true 校验，缺失路径做 false
  const existingPath = join(dir, "real-injected.md");
  await writeFile(existingPath, "content", "utf8");
  const missingPath = join(dir, "never-there.md");
  const report = buildReport(agentId, { existingPath, missingPath });
  await writeLiveSession(agentId, { sessionKey: "agent:x:contract:tc-1", sessionId: "sid-sp", report });
  try {
    const result = await readSessionSystemPrompt(agentId, "sid-sp");
    assert.equal(result.available, true, "live 命中应 available:true");
    assert.deepEqual(result.report, report, "report 应原样返回框架真值");
    assert.equal(result.injectedFiles.length, 2);
    // 第一个文件存在 → persistent true（且保留原字段）+ content 读到正文
    assert.equal(result.injectedFiles[0].persistent, true);
    assert.equal(result.injectedFiles[0].name, "AGENTS.md");
    assert.equal(result.injectedFiles[0].rawChars, 10, "原字段应保留");
    assert.equal(result.injectedFiles[0].content, "content", "精确报告路径应按 path 读 content");
    assert.equal(result.injectedFiles[0].contentChars, 7, "contentChars 应为实际读到字符数");
    assert.equal(result.injectedFiles[0].truncated, false);
    // 第二个文件缺失 → persistent false + content null
    assert.equal(result.injectedFiles[1].persistent, false);
    assert.equal(result.injectedFiles[1].name, "GONE.md");
    assert.equal(result.injectedFiles[1].content, null, "读不到 → content:null");
    assert.equal(result.injectedFiles[1].contentChars, 0);
    // totalContentChars = 各文件 content 字符之和（7 + 0）
    assert.equal(result.totalContentChars, 7, "totalContentChars 应为各文件 content 之和");
  } finally {
    await cleanupAgent(agentId);
  }
});

test("readSessionSystemPrompt：sessionId 不匹配任何条目 → available:false", async () => {
  const agentId = `__sp_nomatch_${Date.now()}__`;
  await writeLiveSession(agentId, { sessionKey: "agent:x:contract:tc-1", sessionId: "sid-A", report: buildReport(agentId, { existingPath: "/x", missingPath: "/y" }) });
  try {
    const result = await readSessionSystemPrompt(agentId, "sid-OTHER");
    assert.deepEqual(result, { available: false }, "sessionId 不匹配 → available:false");
  } finally {
    await cleanupAgent(agentId);
  }
});

test("readSessionSystemPrompt：条目无 systemPromptReport → available:false", async () => {
  const agentId = `__sp_noreport_${Date.now()}__`;
  await writeLiveSession(agentId, { sessionKey: "agent:x:contract:tc-1", sessionId: "sid-sp" }); // 不带 report
  try {
    const result = await readSessionSystemPrompt(agentId, "sid-sp");
    assert.deepEqual(result, { available: false }, "命中条目但无 report → available:false");
  } finally {
    await cleanupAgent(agentId);
  }
});

// ── 2. live 被清 → 回退树内归档 sidecar ───────────────────────────────────────

test("readSessionSystemPrompt：live 被清后回退树内归档 sidecar（经 session-index）", async () => {
  const agentId = `__sp_archive_${Date.now()}__`;
  const lineage = { threadId: "t-sparc", runId: `r-${Date.now()}-sa` };
  const sessionId = `sid-sp-${Date.now()}`;
  const dir = liveSessionsDir(agentId);
  await mkdir(dir, { recursive: true });
  const existingPath = join(dir, "real.md");
  const report = buildReport(agentId, { existingPath, missingPath: "/nope.md" });
  await writeLiveSession(agentId, { sessionKey: "agent:x:contract:tc-1", sessionId, report });
  try {
    // 真实归档段落树：participants/<agent>/session-<sid>.prompt.json + session-index 登记
    const archived = await archiveSessionToRunTree({ agentId, sessionKey: "agent:x:contract:tc-1", lineage });
    assert.equal(archived.archived, true, "前置：归档应成功");
    // 删 live
    await rm(dir, { recursive: true, force: true });

    const result = await readSessionSystemPrompt(agentId, sessionId);
    assert.equal(result.available, true, "live 清后应从树内 sidecar 回退命中");
    assert.deepEqual(result.report, report, "归档 sidecar 内容应与原 report 一致");
    // injectedFiles 仍补 persistent（此时 existingPath 已随 live 删，应 false）
    assert.equal(result.injectedFiles[0].persistent, false, "live 目录删后注入文件已不存在 → persistent false");
  } finally {
    await cleanupAgent(agentId, lineage);
  }
});

// ── 3. 缺参兜底 ────────────────────────────────────────────────────────────────

test("readSessionSystemPrompt：缺参 / 两处皆无 → available:false 不抛", async () => {
  assert.deepEqual(await readSessionSystemPrompt("", "sid"), { available: false });
  assert.deepEqual(await readSessionSystemPrompt("a", ""), { available: false });
  assert.deepEqual(await readSessionSystemPrompt("__no_agent_sp__", "__no_sid__"), { available: false });
});

// ── 5. archiveSessionToRunTree 写树内 sidecar ──────────────────────────────────

test("archiveSessionToRunTree：report 有则写树内 session-<sid>.prompt.json sidecar；无则不写", async () => {
  // 有 report
  const agentWith = `__sp_arc_with_${Date.now()}__`;
  const lineageWith = { threadId: "t-spwith", runId: `r-${Date.now()}-sw` };
  const report = buildReport(agentWith, { existingPath: "/x", missingPath: "/y" });
  await writeLiveSession(agentWith, { sessionKey: "agent:x:contract:tc-1", sessionId: "sid-sp", report });
  try {
    const r = await archiveSessionToRunTree({ agentId: agentWith, sessionKey: "agent:x:contract:tc-1", lineage: lineageWith });
    assert.equal(r.archived, true);
    const sidecarPath = join(participantDir(lineageWith, agentWith), "session-sid-sp.prompt.json");
    const sidecar = JSON.parse(await readFile(sidecarPath, "utf8"));
    assert.deepEqual(sidecar, report, "sidecar 内容应为 systemPromptReport");
  } finally {
    await cleanupAgent(agentWith, lineageWith);
  }

  // 无 report → 不写 sidecar（归档仍成功）
  const agentNo = `__sp_arc_no_${Date.now()}__`;
  const lineageNo = { threadId: "t-spno", runId: `r-${Date.now()}-sn` };
  await writeLiveSession(agentNo, { sessionKey: "agent:x:contract:tc-1", sessionId: "sid-sp" });
  try {
    const r = await archiveSessionToRunTree({ agentId: agentNo, sessionKey: "agent:x:contract:tc-1", lineage: lineageNo });
    assert.equal(r.archived, true, "无 report 也应归档成功（.jsonl + 索引登记）");
    const { existsSync } = await import("node:fs");
    assert.equal(
      existsSync(join(participantDir(lineageNo, agentNo), "session-sid-sp.prompt.json")),
      false,
      "无 report 不应写 sidecar",
    );
  } finally {
    await cleanupAgent(agentNo, lineageNo);
  }
});

// ── 6. surface 合规 + 等价 ─────────────────────────────────────────────────────

test("inspect.session_system_prompt surface 合规", () => {
  const surface = getCliSystemSurface("inspect.session_system_prompt");
  assert.ok(surface, "surface 必须可取到");
  assert.equal(surface.family, "inspect");
  assert.equal(surface.status, "active");
  assert.equal(surface.source, "runtime_inspect");
  assert.equal(surface.operatorExecutable, false);
  assert.equal(surface.displayId, "control:inspect.session_system_prompt");
  const { ok, problems } = validateCliSurface(surface);
  assert.equal(ok, true, `必须通过冻结 schema: ${problems.join("; ")}`);
});

test("inspect.session_system_prompt 经 surface 等价于 readSessionSystemPrompt", async () => {
  const agentId = `__sp_surface_${Date.now()}__`;
  const report = buildReport(agentId, { existingPath: "/x", missingPath: "/y" });
  await writeLiveSession(agentId, { sessionKey: "agent:x:contract:tc-1", sessionId: "sid-sp", report });
  try {
    const direct = await readSessionSystemPrompt(agentId, "sid-sp");
    const viaSurface = await inspectCliSystemSurface({
      surfaceId: "inspect.session_system_prompt",
      params: { agentId, sessionId: "sid-sp" },
    });
    assert.deepEqual(viaSurface, direct, "surface 与直读应等价");
  } finally {
    await cleanupAgent(agentId);
  }
});

// ── 7. 兜底重建（无 systemPromptReport 的中继 agent）────────────────────────────

// 未配置的测试 agent → agentWorkspace 解析为 ~/.openclaw/workspaces/<agentId>
function testWorkspaceDir(agentId) {
  return join(OC_ROOT, "workspaces", agentId);
}

async function cleanupReconstructAgent(agentId) {
  await rm(join(OC_ROOT, "agents", agentId), { recursive: true, force: true });
  await rm(testWorkspaceDir(agentId), { recursive: true, force: true });
}

test("readSessionSystemPrompt：无 report 时从工作区文件重建（source:reconstructed、chars 为和）", async () => {
  const agentId = `__sp_recon_${Date.now()}__`;
  // sessions.json 命中 sessionId 但无 systemPromptReport（模拟中继 agent）
  await writeLiveSession(agentId, { sessionKey: "agent:x:contract:tc-1", sessionId: "sid-r" });
  // 工作区写 SOUL.md / AGENTS.md + memory/note.md
  const ws = testWorkspaceDir(agentId);
  await mkdir(join(ws, "memory"), { recursive: true });
  await writeFile(join(ws, "SOUL.md"), "soul-body", "utf8");       // 9 chars
  await writeFile(join(ws, "AGENTS.md"), "agents", "utf8");        // 6 chars
  await writeFile(join(ws, "memory", "note.md"), "mem", "utf8");   // 3 chars
  try {
    const result = await readSessionSystemPrompt(agentId, "sid-r");
    assert.equal(result.available, true, "应可用（重建）");
    assert.equal(result.source, "reconstructed", "source 应标注 reconstructed");
    assert.equal(result.report.workspaceDir, ws, "report.workspaceDir 应为工作区根");
    // injectedFiles 含三文件（AGENTS.md 先于 SOUL.md，再 memory）
    const names = result.injectedFiles.map((f) => f.name);
    assert.deepEqual(names, ["AGENTS.md", "SOUL.md", join("memory", "note.md")], "清单顺序：根固定清单优先，memory 在后");
    // 每个文件补 persistent:true、rawChars=injectedChars=字符数、truncated:false、content 带正文
    const soul = result.injectedFiles.find((f) => f.name === "SOUL.md");
    assert.equal(soul.persistent, true);
    assert.equal(soul.rawChars, 9);
    assert.equal(soul.injectedChars, 9);
    assert.equal(soul.truncated, false);
    assert.equal(soul.content, "soul-body", "重建路径也应带 content 正文");
    assert.equal(soul.contentChars, 9);
    // systemPrompt.chars = 各 rawChars 之和（9+6+3=18）
    assert.equal(result.report.systemPrompt.chars, 18, "chars 应为各文件 rawChars 之和");
    // totalContentChars = 各 content 之和（9+6+3=18）
    assert.equal(result.totalContentChars, 18, "totalContentChars 应为各文件 content 之和");
    // skills/tools 兜底空数组
    assert.deepEqual(result.report.skills, []);
    assert.deepEqual(result.report.tools, []);
  } finally {
    await cleanupReconstructAgent(agentId);
  }
});

test("readSessionSystemPrompt：工作区无任何注入文件 → available:false", async () => {
  const agentId = `__sp_recon_empty_${Date.now()}__`;
  await writeLiveSession(agentId, { sessionKey: "agent:x:contract:tc-1", sessionId: "sid-r" });
  // 建空工作区目录（无任何清单文件、无 memory）
  await mkdir(testWorkspaceDir(agentId), { recursive: true });
  try {
    const result = await readSessionSystemPrompt(agentId, "sid-r");
    assert.deepEqual(result, { available: false }, "工作区无任何注入文件 → available:false");
  } finally {
    await cleanupReconstructAgent(agentId);
  }
});

test("readSessionSystemPrompt：工作区根本不存在 → available:false（不抛）", async () => {
  const agentId = `__sp_recon_nows_${Date.now()}__`;
  await writeLiveSession(agentId, { sessionKey: "agent:x:contract:tc-1", sessionId: "sid-r" });
  // 不建工作区
  try {
    const result = await readSessionSystemPrompt(agentId, "sid-r");
    assert.deepEqual(result, { available: false });
  } finally {
    await cleanupReconstructAgent(agentId);
  }
});

test("readSessionSystemPrompt：有 systemPromptReport 时仍走精确报告（source 用报告里的，不重建）", async () => {
  const agentId = `__sp_precise_${Date.now()}__`;
  const report = buildReport(agentId, { existingPath: "/x", missingPath: "/y" });
  report.source = "run";
  await writeLiveSession(agentId, { sessionKey: "agent:x:contract:tc-1", sessionId: "sid-sp", report });
  // 即使工作区也有文件，有精确报告时不应触发重建
  const ws = testWorkspaceDir(agentId);
  await mkdir(ws, { recursive: true });
  await writeFile(join(ws, "SOUL.md"), "should-not-be-used", "utf8");
  try {
    const result = await readSessionSystemPrompt(agentId, "sid-sp");
    assert.equal(result.available, true);
    assert.equal(result.source, "run", "有精确报告 → source 用报告里的，不重建");
    assert.deepEqual(result.report, report, "report 应为精确报告原文");
  } finally {
    await cleanupReconstructAgent(agentId);
  }
});

// ── 8. content 上限截断 ─────────────────────────────────────────────────────────

test("readSessionSystemPrompt：大文件 content 截断到 40000 + truncated:true（精确报告路径）", async () => {
  const agentId = `__sp_trunc_${Date.now()}__`;
  const dir = liveSessionsDir(agentId);
  await mkdir(dir, { recursive: true });
  // 写一个超过 40000 字符的大文件
  const bigPath = join(dir, "big.md");
  const bigBody = "x".repeat(40000 + 500); // 40500 chars
  await writeFile(bigPath, bigBody, "utf8");
  const smallPath = join(dir, "small.md");
  await writeFile(smallPath, "tiny", "utf8"); // 4 chars
  const report = {
    source: "run",
    sessionId: "sid-t",
    workspaceDir: dir,
    systemPrompt: { chars: 1 },
    injectedWorkspaceFiles: [
      { name: "big.md", path: bigPath, missing: false, rawChars: bigBody.length, injectedChars: bigBody.length, truncated: false },
      { name: "small.md", path: smallPath, missing: false, rawChars: 4, injectedChars: 4, truncated: false },
    ],
    skills: { entries: [] },
    tools: { entries: [] },
  };
  await writeLiveSession(agentId, { sessionKey: "agent:x:contract:tc-1", sessionId: "sid-t", report });
  try {
    const result = await readSessionSystemPrompt(agentId, "sid-t");
    const big = result.injectedFiles.find((f) => f.name === "big.md");
    assert.equal(big.content.length, 40000, "超上限应 slice 到 40000");
    assert.equal(big.contentChars, 40000);
    assert.equal(big.truncated, true, "截断应标 truncated:true（覆盖报告原 truncated）");
    assert.equal(big.content, bigBody.slice(0, 40000), "content 应为前 40000 字符");
    const small = result.injectedFiles.find((f) => f.name === "small.md");
    assert.equal(small.truncated, false, "小文件不截断");
    assert.equal(small.content, "tiny");
    // totalContentChars = 40000 + 4
    assert.equal(result.totalContentChars, 40004);
  } finally {
    await cleanupAgent(agentId);
  }
});

// ── 9. 六层投影 + activePath（activePath = 本 session 是否含 ⑥wake）────────────────

// 从 layers[] 取指定层（layer 字段）。
function findLayer(layers, layerId) {
  return (Array.isArray(layers) ? layers : []).find((l) => l && l.layer === layerId) || null;
}

test("readSessionSystemPrompt：合约会话 → activePath=dispatch-agent-awake + 六层投影(⑥wake present)", async () => {
  const agentId = `__sp_dual_${Date.now()}__`;
  // 本 agent 自己的合约会话（agentId 匹配 → 系统派工路径，含 ⑥wake）
  await writeLiveSession(agentId, { sessionKey: `agent:${agentId}:contract:TC-DUAL`, sessionId: "sid-d" });
  const ws = testWorkspaceDir(agentId);
  await mkdir(ws, { recursive: true });
  await writeFile(join(ws, "SOUL.md"), "soul-body", "utf8");
  try {
    const r = await readSessionSystemPrompt(agentId, "sid-d");
    assert.equal(r.available, true);
    assert.equal(r.activePath, "dispatch-agent-awake", "合约会话含 ⑥wake（系统派工）");
    assert.equal(r.source, "contract-session-override", "顶层 source 保留字面值（前端判定）");
    // 顶层正文 = 派工完整拼接串（④+⑥+⑤），不内联合约 id（缓存稳定）。
    assert.match(r.injectedFiles[0].content, /You are running inside OpenClaw/, "派工正文在");
    assert.doesNotMatch(r.injectedFiles[0].content, /Contract: `TC-DUAL`/, "不内联合约 id（缓存稳定），由 inbox/wake 提供");
    // 六层投影：六层齐全，scope/source/present 符合派工路。
    assert.ok(Array.isArray(r.layers) && r.layers.length === 6, "应有六层");
    assert.deepEqual(r.layers.map((l) => l.layer), ["framework", "tools", "skills", "role", "soul", "wake"], "层序固定");
    const wake = findLayer(r.layers, "wake");
    assert.equal(wake.present, true, "派工路 ⑥wake present");
    assert.equal(wake.scope, "dispatch-only", "⑥wake 仅系统派工");
    assert.equal(wake.source, "contract-session-override", "⑥wake source");
    assert.ok(typeof wake.content === "string" && wake.content.includes("Current Contract"), "⑥wake 含合约机制骨架");
    assert.equal(findLayer(r.layers, "role").scope, "both", "④role 两路都注入");
    assert.equal(findLayer(r.layers, "soul").present, true, "⑤SOUL present（读到 SOUL.md 正文）");
    assert.equal(findLayer(r.layers, "soul").content, "soul-body", "⑤SOUL 正文 = SOUL.md");
  } finally {
    await cleanupReconstructAgent(agentId);
  }
});

test("readSessionSystemPrompt：直连会话 → activePath=direct-soul（不含 ⑥wake，④role/⑤SOUL 仍在）", async () => {
  const agentId = `__sp_direct_${Date.now()}__`;
  // main 会话（非合约）→ 用户直连路径，不含 ⑥wake
  await writeLiveSession(agentId, { sessionKey: `agent:${agentId}:main`, sessionId: "sid-m" });
  const ws = testWorkspaceDir(agentId);
  await mkdir(ws, { recursive: true });
  await writeFile(join(ws, "SOUL.md"), "soul-body", "utf8");
  try {
    const r = await readSessionSystemPrompt(agentId, "sid-m");
    assert.equal(r.available, true);
    assert.equal(r.activePath, "direct-soul", "main 会话不含 ⑥wake（用户直连）");
    assert.equal(r.source, "reconstructed", "顶层=SOUL（重建）");
    const wake = findLayer(r.layers, "wake");
    assert.equal(wake.present, false, "直连路 ⑥wake 不 present");
    assert.equal(wake.source, "unavailable", "⑥wake 无来源");
    assert.ok(!("content" in wake), "⑥wake 不 present 时不带 content");
    assert.equal(findLayer(r.layers, "soul").present, true, "⑤SOUL 直连路也在");
    assert.equal(findLayer(r.layers, "framework").present, true, "①框架基础任何会话都在");
  } finally {
    await cleanupReconstructAgent(agentId);
  }
});
