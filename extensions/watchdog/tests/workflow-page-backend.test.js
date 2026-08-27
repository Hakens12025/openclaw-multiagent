/**
 * workflow-page-backend.test.js — P-WF1 后端数据层
 *
 * 覆盖：
 *   1. computeAgentWorkflows 无向连通分量 + entry 推导（纯函数）
 *   2. inspect.agent_workflows surface 合规 + 经 surface 等价
 *   3. inspect.agent_sessions：倒序 / 字段 / 缺失兜底 / surface 合规
 *   4. inspect.session_transcript：消息解析 / 文件提取与解析 / persistent 判定 / surface 合规
 *      producedFiles 两条读序都锁在树 outbox 正本目录：封包轮（seal 给清单/主交付物/元数据）
 *      与未封包轮（列目录本身，无封条 → manifest=null）。
 *      注：control-plane/artifacts 副本店整店退役后，原「artifacts store 回退」一例已改写为
 *      未封包轮树 outbox 一例（同一组页面契约断言：available/files/正文/截断/排序/manifest 形状），
 *      「树优先于 store」的读序断言随 store 消失而失去对象，替换为「seal.files 是清单权威、
 *      目录里未列入封条的文件不上页」——这才是封包轮与未封包轮今天真正的分野。
 *   5. POST /watchdog/reveal-file：白名单内放行（mock exec）/ 白名单外 / .. 逃逸 / 405 / 401
 *   6. snapshotInboxToRunTree：快照落盘（run 树 participants/）/ 抛错不冒泡（cleanup 不被破坏）
 *   6b. snapshotOutputToRunTree：产出件复制 / 覆盖 / 缺失 no-op / 抛错吞掉 / agent_end 接入
 *
 * 含时间戳/真实运行态的等价比较已剔时间戳；transcript 用临时 fixture 避免依赖运行态。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

import { computeAgentWorkflows } from "../lib/agent/agent-workflow-grouping.js";
import {
  listAgentSessions,
  parseContractIdFromSessionKey,
} from "../lib/agent/agent-session-store.js";
import { readSessionTranscript } from "../lib/agent/agent-session-transcript.js";
import { readSessionSystemPrompt } from "../lib/agent/agent-session-system-prompt.js";
import {
  revealFileInFinder,
  isPathWithinAllowedRoots,
} from "../lib/agent/agent-reveal-file.js";
import { snapshotInboxToRunTree, snapshotOutputToRunTree } from "../lib/lifecycle/run-tree-snapshot.js";
import { participantOutboxDirFor, recordContractHome, resolveThreadsRoot } from "../lib/archive/thread-tree-store.js";
import { writeOutboxSeal } from "../lib/archive/outbox-seal.js";
import { RUNTIME_RESULT_FILE } from "../lib/protocol/protocol-primitives.js";

import {
  inspectCliSystemSurface,
  getCliSystemSurface,
} from "../lib/cli-system/cli-surface-registry.js";
import { validateCliSurface } from "../lib/cli-system/cli-surface-schema.js";
import { loadGraph } from "../lib/agent/agent-graph.js";
import { register as registerApiRoutes } from "../routes/api.js";

const OC_ROOT = join(homedir(), ".openclaw");

// ── 1. computeAgentWorkflows（纯函数）────────────────────────────────────────

test("computeAgentWorkflows：线性链 a→b→c 归一个分量，entry=入度0 节点", () => {
  const graph = { edges: [{ from: "a", to: "b" }, { from: "b", to: "c" }] };
  const { workflows, byAgent } = computeAgentWorkflows(graph);
  assert.equal(workflows.length, 1, "线性链应是 1 个分量");
  assert.deepEqual(workflows[0].members, ["a", "b", "c"], "成员含 a,b,c 且排序");
  assert.equal(workflows[0].id, "wf:a+b+c", "id 由排序成员稳定生成");
  assert.equal(workflows[0].entry, "a", "entry 应是入度 0 的 a");
  assert.deepEqual(byAgent, { a: "wf:a+b+c", b: "wf:a+b+c", c: "wf:a+b+c" });
});

test("computeAgentWorkflows：两条独立链分成两个分量", () => {
  const graph = { edges: [{ from: "a", to: "b" }, { from: "x", to: "y" }] };
  const { workflows } = computeAgentWorkflows(graph);
  assert.equal(workflows.length, 2, "两条独立链 = 2 个分量");
  const ids = workflows.map((w) => w.id).sort();
  assert.deepEqual(ids, ["wf:a+b", "wf:x+y"]);
  assert.equal(workflows.find((w) => w.id === "wf:a+b").entry, "a");
  assert.equal(workflows.find((w) => w.id === "wf:x+y").entry, "x");
});

test("computeAgentWorkflows：无向连通（反向边也连通）合并为一分量", () => {
  // a→b 与 c→b：三者经 b 无向连通
  const graph = { edges: [{ from: "a", to: "b" }, { from: "c", to: "b" }] };
  const { workflows } = computeAgentWorkflows(graph);
  assert.equal(workflows.length, 1, "经共同节点 b 无向连通应合并");
  assert.deepEqual(workflows[0].members, ["a", "b", "c"]);
  // a 与 c 入度均为 0，排序取首个 a
  assert.equal(workflows[0].entry, "a");
});

test("computeAgentWorkflows：环无入度0节点时 entry 取排序首成员", () => {
  const graph = { edges: [{ from: "a", to: "b" }, { from: "b", to: "a" }] };
  const { workflows } = computeAgentWorkflows(graph);
  assert.equal(workflows.length, 1);
  assert.equal(workflows[0].entry, "a", "环中无入度0，取排序首个");
});

test("computeAgentWorkflows：空图返回空结构", () => {
  assert.deepEqual(computeAgentWorkflows({ edges: [] }), { workflows: [], byAgent: {} });
  assert.deepEqual(computeAgentWorkflows({}), { workflows: [], byAgent: {} });
  assert.deepEqual(computeAgentWorkflows(null), { workflows: [], byAgent: {} });
});

test("computeAgentWorkflows：孤立分量 + 共享节点链各自独立", () => {
  // 链 p→w→w2，独立链 m→n
  const graph = {
    edges: [
      { from: "planner", to: "worker" },
      { from: "worker", to: "worker2" },
      { from: "m", to: "n" },
    ],
  };
  const { workflows, byAgent } = computeAgentWorkflows(graph);
  assert.equal(workflows.length, 2);
  const linear = workflows.find((w) => w.members.includes("planner"));
  assert.deepEqual(linear.members, ["planner", "worker", "worker2"]);
  assert.equal(linear.entry, "planner");
  assert.equal(byAgent.worker2, linear.id);
});

// ── 2. inspect.agent_workflows surface ───────────────────────────────────────

test("inspect.agent_workflows surface 合规", () => {
  const surface = getCliSystemSurface("inspect.agent_workflows");
  assert.ok(surface, "surface 必须可取到");
  assert.equal(surface.family, "inspect");
  assert.equal(surface.status, "active");
  assert.equal(surface.source, "runtime_inspect");
  assert.equal(surface.operatorExecutable, false);
  assert.equal(surface.displayId, "control:inspect.agent_workflows");
  const { ok, problems } = validateCliSurface(surface);
  assert.equal(ok, true, `必须通过冻结 schema: ${problems.join("; ")}`);
});

test("inspect.agent_workflows 经 surface 等价于 computeAgentWorkflows(loadGraph())", async () => {
  const direct = computeAgentWorkflows(await loadGraph());
  const viaSurface = await inspectCliSystemSurface({ surfaceId: "inspect.agent_workflows" });
  assert.deepEqual(viaSurface, direct, "surface 与纯函数组合应等价");
});

// ── 3. inspect.agent_sessions ────────────────────────────────────────────────

test("parseContractIdFromSessionKey：冒号/连字符两形式 + 缺失 null", () => {
  assert.equal(parseContractIdFromSessionKey("agent:worker2:contract:tc-123-abc"), "tc-123-abc");
  assert.equal(parseContractIdFromSessionKey("agent:w:run-contract-cid42:more"), "cid42");
  assert.equal(parseContractIdFromSessionKey("agent:w:direct:foo"), null, "无 contract 段 → null");
  assert.equal(parseContractIdFromSessionKey(""), null);
  assert.equal(parseContractIdFromSessionKey(null), null);
});

test("inspect.agent_sessions surface 合规", () => {
  const surface = getCliSystemSurface("inspect.agent_sessions");
  assert.ok(surface);
  assert.equal(surface.family, "inspect");
  assert.equal(surface.displayId, "control:inspect.agent_sessions");
  const { ok, problems } = validateCliSurface(surface);
  assert.equal(ok, true, problems.join("; "));
});

test("listAgentSessions：缺失文件兜底 []，且经 surface 等价", async () => {
  const direct = await listAgentSessions("__no_such_agent_wf__");
  assert.deepEqual(direct, [], "不存在的 agent → []");
  const viaSurface = await inspectCliSystemSurface({
    surfaceId: "inspect.agent_sessions",
    params: { agentId: "__no_such_agent_wf__" },
  });
  assert.deepEqual(viaSurface, direct, "surface 与直读应等价");
  // 空 agentId 也兜底
  assert.deepEqual(await listAgentSessions(""), []);
});

test("listAgentSessions：倒序 + 字段 + contractId 解析（临时 fixture）", async () => {
  const agentId = `__wf_sessions_${Date.now()}__`;
  const dir = join(OC_ROOT, "agents", agentId, "sessions");
  await mkdir(dir, { recursive: true });
  const fixture = {
    "agent:x:contract:tc-old": {
      sessionId: "sess-old", updatedAt: 100, model: "m1", totalTokens: 5,
    },
    "agent:x:contract:tc-new": {
      sessionId: "sess-new", updatedAt: 999, model: "m2", totalTokens: 7,
    },
    "agent:x:direct:bare": {
      sessionId: "sess-bare", updatedAt: 500, model: "m3", totalTokens: 0,
    },
  };
  await writeFile(join(dir, "sessions.json"), JSON.stringify(fixture), "utf8");
  try {
    const list = await listAgentSessions(agentId);
    assert.equal(list.length, 3);
    // 倒序：999 > 500 > 100
    assert.deepEqual(list.map((s) => s.sessionId), ["sess-new", "sess-bare", "sess-old"]);
    // 字段完整
    assert.deepEqual(list[0], {
      sessionId: "sess-new",
      sessionKey: "agent:x:contract:tc-new",
      contractId: "tc-new",
      updatedAt: 999,
      model: "m2",
      totalTokens: 7,
    });
    // 无 contract 段 → contractId null
    assert.equal(list.find((s) => s.sessionId === "sess-bare").contractId, null);
  } finally {
    await rm(join(OC_ROOT, "agents", agentId), { recursive: true, force: true });
  }
});

// ── 4. inspect.session_transcript ─────────────────────────────────────────────

test("inspect.session_transcript surface 合规", () => {
  const surface = getCliSystemSurface("inspect.session_transcript");
  assert.ok(surface);
  assert.equal(surface.family, "inspect");
  assert.equal(surface.displayId, "control:inspect.session_transcript");
  const { ok, problems } = validateCliSurface(surface);
  assert.equal(ok, true, problems.join("; "));
});

test("readSessionTranscript：消息解析 + 文件提取/解析 + persistent 判定（临时 fixture）", async () => {
  const agentId = `__wf_transcript_${Date.now()}__`;
  const sessionId = "sess-tr";
  const dir = join(OC_ROOT, "agents", agentId, "sessions");
  await mkdir(dir, { recursive: true });

  // 合约正本落树店（contract-index 登记 → resolveSharedContractPathById 可解析）
  const contractId = `tc-xyz-${Date.now()}`;
  const lineage = { threadId: `t-wf-${Date.now()}`, runId: "r-wf" };
  await recordContractHome(contractId, lineage);

  // 落一个真实存在的 output 正本，用于 persistent=true 校验
  const outputName = `__wf_test_${Date.now()}__.md`;
  const outputDir = join(OC_ROOT, "control-plane", "output");
  await mkdir(outputDir, { recursive: true });
  await writeFile(join(outputDir, outputName), "result body", "utf8");

  const lines = [
    // 非 message 行应被忽略
    { type: "session", id: "s0" },
    // user 消息（字符串 content）
    { type: "message", timestamp: "2026-05-30T00:00:00.000Z", message: { role: "user", content: "hello" } },
    // assistant：thinking + text + tool_use(read inbox contract) + tool_use(write output)
    {
      type: "message",
      timestamp: "2026-05-30T00:00:01.000Z",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "let me read" },
          { type: "text", text: "reading now" },
          { type: "tool_use", name: "read", input: { file_path: `workspaces/${agentId}/inbox/contract.json` } },
          { type: "tool_use", name: "write", input: { file_path: `workspaces/${agentId}/output/${outputName}` } },
        ],
      },
    },
    // tool_result：含 control-plane/output 路径文本
    {
      type: "message",
      timestamp: "2026-05-30T00:00:02.000Z",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: `wrote to control-plane/output/${outputName}` },
        ],
      },
    },
    // 损坏行（非 JSON）应被跳过而不中断
    "{ this is broken json",
  ];
  const jsonl = lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n");
  await writeFile(join(dir, `${sessionId}.jsonl`), jsonl, "utf8");

  try {
    // 直接调用，传 contractId 以解析 inbox contract 正本
    const tr = await readSessionTranscript(agentId, sessionId, { contractId });
    assert.equal(tr.agentId, agentId);
    assert.equal(tr.sessionId, sessionId);
    // 3 条 message（session 行 + 损坏行被滤）
    assert.equal(tr.messages.length, 3, "应解析出 3 条 message");

    const [u1, a1, u2] = tr.messages;
    assert.equal(u1.role, "user");
    assert.equal(u1.text, "hello");
    assert.equal(a1.role, "assistant");
    assert.equal(a1.thinking, "let me read");
    assert.equal(a1.text, "reading now");
    assert.equal(a1.toolCalls.length, 2);
    assert.deepEqual(a1.toolCalls[0], { name: "read", args: { file_path: `workspaces/${agentId}/inbox/contract.json` } });
    assert.equal(u2.toolResults.length, 1);
    assert.equal(u2.toolResults[0].tool, "t1");
    assert.match(u2.toolResults[0].contentText, /control-plane\/output/);

    // referencedFiles：inbox contract（kind=contract，经 contract-index 解析到树店正本）
    const contractRef = tr.referencedFiles.find((f) => f.kind === "contract");
    assert.ok(contractRef, "应抽出 inbox contract 引用");
    assert.match(
      contractRef.resolvedPath,
      new RegExp(`runs/${lineage.runId}/contracts/${contractId}\\.json$`),
      "应解析到树店合约正本",
    );

    // output 引用（kind=output，解析到 control-plane/output，persistent=true 因正本存在）
    const outputRef = tr.referencedFiles.find((f) => f.kind === "output" && f.resolvedPath.endsWith(outputName));
    assert.ok(outputRef, "应抽出 output 引用");
    assert.match(outputRef.resolvedPath, new RegExp(`control-plane/output/${outputName.replace(/[.]/g, "\\.")}$`));
    assert.equal(outputRef.persistent, true, "正本存在 → persistent=true");

    // surface 路径：transcript 经 surface（不传 contractId，走 session 列表解析；无 sessions.json → contractId null）
    const viaSurface = await inspectCliSystemSurface({
      surfaceId: "inspect.session_transcript",
      params: { agentId, sessionId },
    });
    assert.equal(viaSurface.messages.length, tr.messages.length, "surface 消息数与直读一致");
  } finally {
    await rm(join(OC_ROOT, "agents", agentId), { recursive: true, force: true });
    await rm(join(outputDir, outputName), { force: true });
  }
});

test("readSessionTranscript：真实 .jsonl 格式(toolCall/arguments + 独立 toolResult 消息)抽取工具调用与引用文件", async () => {
  const agentId = `__wf_real_${Date.now()}__`;
  const sessionId = "sess-real";
  const dir = join(OC_ROOT, "agents", agentId, "sessions");
  await mkdir(dir, { recursive: true });
  const outputName = `__wf_real_${Date.now()}__.md`;
  const outputDir = join(OC_ROOT, "control-plane", "output");
  await mkdir(outputDir, { recursive: true });
  const outputPath = join(outputDir, outputName);
  await writeFile(outputPath, "body", "utf8");
  const inboxPath = join(OC_ROOT, "workspaces", agentId, "inbox", "contract.json");
  // 正本用大写 TC-REAL-*，但 contractId 传小写 —— 验证索引键侧小写归一(sessionKey 会小写 contractId)，
  // 路径侧仍用登记原串（树店文件名保留大写）
  const upperId = `TC-REAL-${Date.now()}`;
  const lineage = { threadId: `t-wfreal-${Date.now()}`, runId: "r-wfreal" };
  await recordContractHome(upperId, lineage);
  const contractsDir = join(resolveThreadsRoot(), lineage.threadId, "runs", lineage.runId, "contracts");
  await mkdir(contractsDir, { recursive: true });
  const contractFile = join(contractsDir, `${upperId}.json`);
  await writeFile(contractFile, "{}", "utf8");

  const lines = [
    { type: "message", timestamp: "2026-05-30T00:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "go" }] } },
    {
      type: "message", timestamp: "2026-05-30T00:00:01.000Z",
      message: { role: "assistant", content: [
        { type: "thinking", thinking: "read then write" },
        { type: "toolCall", id: "c1", name: "read", arguments: { path: inboxPath } },
        { type: "toolCall", id: "c2", name: "write", arguments: { path: outputPath, content: "x" } },
      ] },
    },
    { type: "message", timestamp: "2026-05-30T00:00:02.000Z",
      message: { role: "toolResult", toolCallId: "c2", toolName: "write", content: [{ type: "text", text: `Successfully wrote 1 bytes to ${outputPath}` }] } },
  ];
  await writeFile(join(dir, `${sessionId}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n"), "utf8");

  try {
    const tr = await readSessionTranscript(agentId, sessionId, { contractId: upperId.toLowerCase() });
    const asst = tr.messages.find((m) => m.role === "assistant");
    assert.ok(asst, "应有 assistant 消息");
    assert.equal(asst.toolCalls.length, 2, "应抽出 2 个 toolCall(来自 toolCall/arguments)");
    assert.equal(asst.toolCalls[0].name, "read");
    assert.equal(asst.toolCalls[0].args.path, inboxPath, "args 来自 arguments 字段");

    const trMsg = tr.messages.find((m) => m.role === "toolResult");
    assert.ok(trMsg, "应有独立 toolResult 消息");
    assert.equal(trMsg.toolResults.length, 1, "独立 toolResult 消息应补成 toolResults 项");
    assert.equal(trMsg.toolResults[0].tool, "write");

    const contractRef = tr.referencedFiles.find((f) => f.kind === "contract");
    assert.ok(contractRef, "应从 toolCall arguments.path 抽出 inbox contract 引用");
    // 小写 contractId(sessionKey 来)经索引小写键命中,路径用登记原串(大写文件名),
    // 故 persistent=true、reveal(open -R)可打开(大小写归一只在索引键侧,不进路径)。
    assert.match(
      contractRef.resolvedPath,
      new RegExp(`runs/${lineage.runId}/contracts/${upperId}\\.json$`),
      "应经索引解析到树店正本(路径保留登记原串大小写)",
    );
    assert.equal(contractRef.persistent, true, "树店正本存在 → persistent=true → 可 reveal");
    const outputRef = tr.referencedFiles.find((f) => f.kind === "output" && f.resolvedPath.endsWith(outputName));
    assert.ok(outputRef, "应抽出 output 引用");
    assert.equal(outputRef.persistent, true, "output 正本存在 → persistent=true");
  } finally {
    await rm(join(OC_ROOT, "agents", agentId), { recursive: true, force: true });
    await rm(join(OC_ROOT, "workspaces", agentId), { recursive: true, force: true });
    await rm(outputPath, { force: true });
    await rm(join(resolveThreadsRoot(), lineage.threadId), { recursive: true, force: true });
  }
});

test("readSessionTranscript：缺失文件兜底空结构", async () => {
  const tr = await readSessionTranscript("__no_agent__", "__no_session__");
  assert.equal(tr.sessionId, "__no_session__");
  assert.equal(tr.agentId, "__no_agent__");
  assert.deepEqual(tr.messages, []);
  assert.deepEqual(tr.referencedFiles, []);
  // delivery 字段存在且为合法结构（__no_agent__ 不在 graph → 无出边 = 叶子 = isTerminal:true，但无产出件 available:false）
  assert.equal(tr.delivery.isTerminal, true);
  assert.equal(tr.delivery.available, false);
  // producedFiles 字段存在且兜底为不可用空结构
  assert.equal(tr.producedFiles.available, false);
  assert.deepEqual(tr.producedFiles.files, []);
});

test("readSessionSystemPrompt：合约会话 → source=contract-session-override（agent-awake 实际提示词）", async () => {
  const agentId = `__wf_sysprompt_${Date.now()}__`;
  const dir = join(OC_ROOT, "agents", agentId, "sessions");
  await mkdir(dir, { recursive: true });
  const sessionId = "sess-override";
  await writeFile(join(dir, "sessions.json"), JSON.stringify({
    [`agent:${agentId}:contract:TC-OVERRIDE-1`]: { sessionId, updatedAt: 100, model: "m", totalTokens: 1 },
  }), "utf8");
  try {
    const r = await readSessionSystemPrompt(agentId, sessionId);
    assert.equal(r.available, true);
    assert.equal(r.source, "contract-session-override", "合约会话应返回 agent-awake 覆盖层（非 SOUL 重建）");
    assert.equal(r.injectedFiles.length, 1);
    const content = r.injectedFiles[0].content || "";
    assert.match(content, /You are running inside OpenClaw/, "应是合约会话系统提示词正文");
    assert.doesNotMatch(content, /Contract: `TC-OVERRIDE-1`/, "合约 id 不内联(缓存稳定),由 inbox/wake 提供");
  } finally {
    await rm(join(OC_ROOT, "agents", agentId), { recursive: true, force: true });
  }
});

test("readSessionTranscript：producedFiles 未封包轮读树 outbox 目录本身（无封条 → manifest=null，控制载荷不上页）", async () => {
  const cid = `tc-produced-${Date.now()}`;
  const agentId = "planner";
  const lineage = { threadId: `t-produced-unsealed-${Date.now()}`, runId: "r-1" };
  await recordContractHome(cid, lineage);
  // 仍在跑 / 崩溃轮 / 采集失败：树 outbox 正本目录在，但没有 seal.json
  const treeOutbox = participantOutboxDirFor(lineage, agentId, cid);
  await mkdir(treeOutbox, { recursive: true });
  await writeFile(join(treeOutbox, "report.md"), "# 报告正文", "utf8");
  await writeFile(join(treeOutbox, "data.json"), '{"k":1}', "utf8");
  await writeFile(join(treeOutbox, RUNTIME_RESULT_FILE), '{"status":"completed"}', "utf8");
  try {
    const tr = await readSessionTranscript(agentId, "__nofile__", { contractId: cid });
    assert.equal(tr.producedFiles.available, true, "未封包也应可用（目录本身就是正本）");
    assert.equal(tr.producedFiles.files.length, 2, "两个产物文件（控制载荷不计入）");
    assert.equal(
      tr.producedFiles.files.some((f) => f.name === RUNTIME_RESULT_FILE),
      false,
      "runtime_result.json 是控制载荷，不是交付物",
    );
    const report = tr.producedFiles.files.find((f) => f.name === "report.md");
    assert.ok(report, "应含 report.md");
    assert.equal(report.content, "# 报告正文", "正文应内显");
    assert.equal(report.chars, "# 报告正文".length);
    assert.equal(report.truncated, false);
    assert.equal(report.primary, false, "无封条 → 无主交付物，全员 primary:false");
    assert.ok(
      report.path.endsWith(join(`outbox-${cid}`, "report.md")),
      "数据源必须是树 outbox 正本目录本身（页面看到的是产物本身，不是某处副本）",
    );
    assert.equal(tr.producedFiles.manifest, null, "无封条 → 无 producer/producedAt/summary/primary 这组元数据");
  } finally {
    await rm(join(resolveThreadsRoot(), lineage.threadId), { recursive: true, force: true });
  }
});

test("readSessionTranscript：producedFiles 封包轮以 seal 为清单权威（seal.files 之外的文件不上页 + 主交付物排前）", async () => {
  const cid = `tc-produced-tree-${Date.now()}`;
  const agentId = "planner";
  const lineage = { threadId: `t-produced-${Date.now()}`, runId: "r-1" };
  await recordContractHome(cid, lineage);
  const treeOutbox = participantOutboxDirFor(lineage, agentId, cid);
  await mkdir(treeOutbox, { recursive: true });
  await writeFile(join(treeOutbox, "report.md"), "# 树内报告", "utf8");
  await writeFile(join(treeOutbox, "data.json"), '{"k":2}', "utf8");
  // 目录里躺着但封条没列的文件：封包轮读序以 seal.files 为准，它不该上页
  await writeFile(join(treeOutbox, "scratch.txt"), "草稿", "utf8");
  await writeOutboxSeal(treeOutbox, {
    contractId: cid,
    sessionKey: `agent:${agentId}:contract:${cid}`,
    collectedAt: Date.now(),
    primary: "report.md",
    files: ["report.md", "data.json"],
    declaredStatus: "completed",
  });
  try {
    const tr = await readSessionTranscript(agentId, "__nofile__", { contractId: cid });
    assert.equal(tr.producedFiles.available, true, "sealed 树 outbox 应可用");
    assert.equal(tr.producedFiles.files.length, 2, "清单来自 seal.files（不是目录列表）");
    assert.equal(
      tr.producedFiles.files.some((f) => f.name === "scratch.txt"),
      false,
      "封条未列的文件不算采集事实，不上页",
    );
    assert.equal(tr.producedFiles.files[0].name, "report.md", "主交付物排前");
    assert.equal(tr.producedFiles.files[0].primary, true);
    assert.equal(tr.producedFiles.files[0].content, "# 树内报告", "正文来自树内正本");
    assert.equal(tr.producedFiles.manifest.producer, agentId);
    assert.equal(tr.producedFiles.manifest.primary, "report.md");
    assert.ok(typeof tr.producedFiles.manifest.producedAt === "string", "producedAt 由 seal.collectedAt 演算");
  } finally {
    await rm(join(resolveThreadsRoot(), lineage.threadId), { recursive: true, force: true });
  }
});

// ── 5. POST /watchdog/reveal-file ─────────────────────────────────────────────

test("isPathWithinAllowedRoots：白名单内放行 / 外拒 / .. 逃逸拒", () => {
  assert.equal(isPathWithinAllowedRoots(join(OC_ROOT, "control-plane", "output", "x.md")), true);
  assert.equal(isPathWithinAllowedRoots(join(OC_ROOT, "workspaces", "w", "inbox", "c.json")), true);
  assert.equal(isPathWithinAllowedRoots(join(OC_ROOT, "agents", "a", "sessions", "s.jsonl")), true);
  assert.equal(isPathWithinAllowedRoots("/etc/passwd"), false, "白名单外应拒");
  assert.equal(isPathWithinAllowedRoots(join(OC_ROOT, "openclaw.json")), false, "OC 根下非白名单子树应拒");
  // 前缀误匹配防护：workspaces-evil 不应匹配 workspaces
  assert.equal(isPathWithinAllowedRoots(join(OC_ROOT, "workspaces-evil", "x")), false);
});

test("revealFileInFinder：白名单内放行（mock exec，不真跑 open；platform 注入保证跨平台跑测定值）", async () => {
  let captured = null;
  const exec = (cmd, args, cb) => { captured = { cmd, args }; cb(null); };
  const target = join(OC_ROOT, "control-plane", "output", "x.md");
  const result = await revealFileInFinder(target, { exec, platform: "darwin" });
  assert.deepEqual(result, { ok: true, resolvedPath: target });
  assert.equal(captured.cmd, "open");
  assert.deepEqual(captured.args, ["-R", target], "darwin 应 execFile open -R <path>（无 shell）");
});

test("revealFileInFinder：白名单外 / .. 逃逸被拒（exec 不被调用）", async () => {
  let called = false;
  const exec = () => { called = true; };
  await assert.rejects(
    () => revealFileInFinder("/etc/passwd", { exec }),
    /path not allowed/,
  );
  await assert.rejects(
    () => revealFileInFinder(join(OC_ROOT, "control-plane", "..", "..", "etc", "passwd"), { exec }),
    /path not allowed/,
    ".. 逃逸出白名单应被拒",
  );
  await assert.rejects(() => revealFileInFinder("", { exec }), /path required/);
  assert.equal(called, false, "拒绝时绝不调用 exec");
});

// route harness：注册 api routes 并取 /watchdog/reveal-file
const apiRoutes = (() => {
  const routes = new Map();
  const api = {
    registerHttpRoute(route) { routes.set(route.path, route); },
    config: {},
  };
  const logger = { info() {}, warn() {}, error() {} };
  registerApiRoutes(api, logger, {});
  return routes;
})();

function buildRevealReq(method, body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  let i = 0;
  return {
    method,
    url: "/watchdog/reveal-file",
    [Symbol.asyncIterator]() {
      return { next: () => Promise.resolve(i < chunks.length ? { value: chunks[i++], done: false } : { value: undefined, done: true }) };
    },
  };
}

function buildRevealRes() {
  return {
    statusCode: null,
    headers: null,
    _chunks: [],
    writeHead(status, headers) { this.statusCode = status; this.headers = headers; return this; },
    end(chunk) { if (chunk !== undefined) this._chunks.push(chunk); return this; },
    json() { const raw = this._chunks.join(""); return raw ? JSON.parse(raw) : null; },
  };
}

test("POST /watchdog/reveal-file：路由已注册", () => {
  assert.ok(apiRoutes.get("/watchdog/reveal-file"), "reveal-file 路由必须注册");
});

test("POST /watchdog/reveal-file：白名单外 → 403", async () => {
  const route = apiRoutes.get("/watchdog/reveal-file");
  const req = buildRevealReq("POST", { path: "/etc/passwd" });
  const res = buildRevealRes();
  await route.handler(req, res);
  assert.equal(res.statusCode, 403, "白名单外应 403");
  assert.equal(res.json().ok, false);
});

test("POST /watchdog/reveal-file：缺 path → 400", async () => {
  const route = apiRoutes.get("/watchdog/reveal-file");
  const req = buildRevealReq("POST", {});
  const res = buildRevealRes();
  await route.handler(req, res);
  assert.equal(res.statusCode, 400);
});

test("POST /watchdog/reveal-file：非 POST → 405", async () => {
  const route = apiRoutes.get("/watchdog/reveal-file");
  const req = buildRevealReq("GET");
  const res = buildRevealRes();
  await route.handler(req, res);
  assert.equal(res.statusCode, 405, "非 POST 应 405");
});

// ── 5b. GET /watchdog/inspect（前端只读观测 HTTP 面）─────────────────────────

function buildInspectReq(method, query) {
  return {
    method,
    url: `/watchdog/inspect${query ? `?${query}` : ""}`,
    [Symbol.asyncIterator]() {
      return { next: () => Promise.resolve({ value: undefined, done: true }) };
    },
  };
}

test("GET /watchdog/inspect：路由已注册", () => {
  assert.ok(apiRoutes.get("/watchdog/inspect"), "inspect 路由必须注册");
});

test("GET /watchdog/inspect：inspect 家族 surface 放行并返回数据", async () => {
  const route = apiRoutes.get("/watchdog/inspect");
  const req = buildInspectReq("GET", "surface=inspect.agent_workflows");
  const res = buildRevealRes();
  await route.handler(req, res);
  assert.equal(res.statusCode, 200, "inspect surface 应放行 200");
  const data = res.json();
  // computeAgentWorkflows 返回 { workflows, byAgent }
  assert.ok(Array.isArray(data.workflows), "应返回 workflows 数组");
  assert.equal(typeof data.byAgent, "object");
  // 经 route 返回应与直接 surface 调用等价
  const direct = await inspectCliSystemSurface({ surfaceId: "inspect.agent_workflows" });
  assert.deepEqual(data, direct, "route 返回应与 surface 直调等价");
});

test("GET /watchdog/inspect：缺 surface → 400", async () => {
  const route = apiRoutes.get("/watchdog/inspect");
  const req = buildInspectReq("GET", "");
  const res = buildRevealRes();
  await route.handler(req, res);
  assert.equal(res.statusCode, 400, "缺 surface 应 400");
});

test("GET /watchdog/inspect：未知 surface → 403", async () => {
  const route = apiRoutes.get("/watchdog/inspect");
  const req = buildInspectReq("GET", "surface=inspect.__nope__");
  const res = buildRevealRes();
  await route.handler(req, res);
  assert.equal(res.statusCode, 403, "未知 surface 应 403");
});

test("GET /watchdog/inspect：非 inspect 家族 surface 拒绝 → 403（不允许经此调 apply/admin）", async () => {
  const route = apiRoutes.get("/watchdog/inspect");
  // graph.edge.add 是 apply/admin 家族写 surface
  const req = buildInspectReq("GET", "surface=graph.edge.add");
  const res = buildRevealRes();
  await route.handler(req, res);
  assert.equal(res.statusCode, 403, "非 inspect 家族应 403");
});

// ── 6. snapshotInboxToRunTree ──────────────────────────────────────────────────

const SNAPSHOT_LINEAGE = { threadId: "t-wfsnap", runId: "r-1-wfsnap" };

function snapshotParticipantDir(agentId) {
  return join(
    resolveThreadsRoot(),
    SNAPSHOT_LINEAGE.threadId,
    "runs",
    SNAPSHOT_LINEAGE.runId,
    "participants",
    agentId,
  );
}

async function cleanupSnapshotThread() {
  await rm(join(resolveThreadsRoot(), SNAPSHOT_LINEAGE.threadId), { recursive: true, force: true });
}

test("snapshotInboxToRunTree：有谱系+contractId 时快照 inbox 文件落到 participants/<agent>/inbox-<cid>/", async () => {
  const srcRoot = await mkdtemp(join(tmpdir(), "wf-inbox-"));
  await writeFile(join(srcRoot, "contract.json"), JSON.stringify({ id: "tc-snap" }), "utf8");
  await writeFile(join(srcRoot, "note.md"), "hi", "utf8");

  const contractId = `tc-snap-${Date.now()}`;
  const agentId = "worker-snap";
  try {
    const result = await snapshotInboxToRunTree({
      lineage: SNAPSHOT_LINEAGE, contractId, agentId, inboxDir: srcRoot,
    });
    assert.equal(result.snapshotted, true);
    const { existsSync, readFileSync } = await import("node:fs");
    const dest = join(snapshotParticipantDir(agentId), `inbox-${contractId}`);
    assert.equal(result.dest, dest, "dest 应为 participants/<agent>/inbox-<cid>/");
    assert.equal(existsSync(join(dest, "contract.json")), true, "contract.json 应被快照");
    assert.equal(existsSync(join(dest, "note.md")), true, "note.md 应被快照");
    assert.equal(readFileSync(join(dest, "note.md"), "utf8"), "hi");
  } finally {
    await rm(srcRoot, { recursive: true, force: true });
    await cleanupSnapshotThread();
  }
});

test("snapshotInboxToRunTree：inbox/upstream 链条目物化为内容自足副本（dereference）", async () => {
  const srcRoot = await mkdtemp(join(tmpdir(), "wf-inbox-link-"));
  const linkTarget = await mkdtemp(join(tmpdir(), "wf-inbox-target-"));
  await writeFile(join(linkTarget, "report.md"), "上游正本", "utf8");
  await mkdir(join(srcRoot, "upstream"), { recursive: true });
  const { symlink } = await import("node:fs/promises");
  await symlink(linkTarget, join(srcRoot, "upstream", "planner"), "dir");

  const contractId = `tc-snap-link-${Date.now()}`;
  const agentId = "worker-snap-link";
  try {
    const result = await snapshotInboxToRunTree({
      lineage: SNAPSHOT_LINEAGE, contractId, agentId, inboxDir: srcRoot,
    });
    assert.equal(result.snapshotted, true);
    const { lstatSync, readFileSync } = await import("node:fs");
    const destDir = join(snapshotParticipantDir(agentId), `inbox-${contractId}`, "upstream", "planner");
    assert.equal(lstatSync(destDir).isSymbolicLink(), false, "快照条目应是物化目录,非链");
    assert.equal(readFileSync(join(destDir, "report.md"), "utf8"), "上游正本", "证据面内容自足,独立于产者 run 的 GC");
  } finally {
    await rm(srcRoot, { recursive: true, force: true });
    await rm(linkTarget, { recursive: true, force: true });
    await cleanupSnapshotThread();
  }
});

test("snapshotInboxToRunTree：缺 lineage / contractId / agentId / inboxDir → no-op（不抛）", async () => {
  assert.deepEqual(await snapshotInboxToRunTree({ lineage: SNAPSHOT_LINEAGE, agentId: "a", inboxDir: "/x" }), { snapshotted: false, dest: null });
  assert.deepEqual(await snapshotInboxToRunTree({ lineage: SNAPSHOT_LINEAGE, contractId: "c", inboxDir: "/x" }), { snapshotted: false, dest: null });
  assert.deepEqual(await snapshotInboxToRunTree({ lineage: SNAPSHOT_LINEAGE, contractId: "c", agentId: "a" }), { snapshotted: false, dest: null });
  // 无谱系（=无合约轮次）无 run 家 → 不快照
  assert.deepEqual(await snapshotInboxToRunTree({ contractId: "c", agentId: "a", inboxDir: "/x" }), { snapshotted: false, dest: null });
  assert.deepEqual(await snapshotInboxToRunTree({}), { snapshotted: false, dest: null });
});

test("snapshotInboxToRunTree：源不存在时抛错（由调用方 try/catch 吞掉，验证不破坏 cleanup 契约）", async () => {
  // 源目录不存在 → cp 抛错。验证错误冒泡到调用方（调用方负责吞）。
  try {
    await assert.rejects(
      () => snapshotInboxToRunTree({
        lineage: SNAPSHOT_LINEAGE,
        contractId: "tc-missing",
        agentId: "w",
        inboxDir: join(tmpdir(), `__never_exists_${Date.now()}__`),
      }),
      "源不存在应抛错（调用方 try/catch 兜底，不影响 unlink）",
    );
  } finally {
    await cleanupSnapshotThread();
  }
});

// cleanup 接入点：cleanupAgentEndTransport 包了 try/catch，快照抛错不冒泡
test("agent-end-transport：快照调用包在 try/catch（快照失败不破坏清理）", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("../lib/lifecycle/agent-end/transport.js", import.meta.url), "utf8");
  assert.match(src, /snapshotInboxToRunTree/, "应接入 snapshotInboxToRunTree");
  // 快照调用必须在 cleanInbox（unlink 发生处）之前
  const snapIdx = src.indexOf("snapshotInboxToRunTree");
  const cleanIdx = src.indexOf("await cleanInbox");
  assert.ok(snapIdx >= 0 && cleanIdx >= 0 && snapIdx < cleanIdx, "快照必须在 cleanInbox 之前");
  // 快照段必须在 try/catch 内
  assert.match(src, /try\s*\{[\s\S]*snapshotInboxToRunTree[\s\S]*\}\s*catch/, "快照应包在 try/catch 内");
});

// ── 6b. snapshotOutputToRunTree（产出件快照）──────────────────────────────────

test("snapshotOutputToRunTree：复制产出件到 participants/<agent>/delivery-<cid>.md", async () => {
  const srcRoot = await mkdtemp(join(tmpdir(), "wf-output-"));
  const outputPath = join(srcRoot, "tc-x.md");
  await writeFile(outputPath, "用户最终件", "utf8");

  const contractId = `tc-outsnap-${Date.now()}`;
  const agentId = "worker-outsnap";
  try {
    const result = await snapshotOutputToRunTree({
      lineage: SNAPSHOT_LINEAGE, contractId, agentId, outputPath,
    });
    assert.equal(result.snapshotted, true);
    const { existsSync, readFileSync } = await import("node:fs");
    const dest = join(snapshotParticipantDir(agentId), `delivery-${contractId}.md`);
    assert.equal(result.dest, dest, "dest 应为 participants/<agent>/delivery-<cid>.md");
    assert.equal(existsSync(dest), true, "产出件应被快照");
    assert.equal(readFileSync(dest, "utf8"), "用户最终件");
  } finally {
    await rm(srcRoot, { recursive: true, force: true });
    await cleanupSnapshotThread();
  }
});

test("snapshotOutputToRunTree：覆盖写（last-writer-wins，重跑覆盖为最新件）", async () => {
  const srcRoot = await mkdtemp(join(tmpdir(), "wf-output-"));
  const outputPath = join(srcRoot, "tc-x.md");
  const contractId = `tc-outover-${Date.now()}`;
  const agentId = "worker-outover";
  try {
    await writeFile(outputPath, "FIRST", "utf8");
    await snapshotOutputToRunTree({ lineage: SNAPSHOT_LINEAGE, contractId, agentId, outputPath });
    await writeFile(outputPath, "SECOND", "utf8");
    await snapshotOutputToRunTree({ lineage: SNAPSHOT_LINEAGE, contractId, agentId, outputPath });
    const { readFileSync } = await import("node:fs");
    assert.equal(
      readFileSync(join(snapshotParticipantDir(agentId), `delivery-${contractId}.md`), "utf8"),
      "SECOND",
      "应覆盖为最新内容",
    );
  } finally {
    await rm(srcRoot, { recursive: true, force: true });
    await cleanupSnapshotThread();
  }
});

test("snapshotOutputToRunTree：产出件不存在 / 缺 lineage / contractId / agentId → no-op（不抛）", async () => {
  // 产出件不存在
  assert.deepEqual(
    await snapshotOutputToRunTree({ lineage: SNAPSHOT_LINEAGE, contractId: "tc-x", agentId: "a", outputPath: join(tmpdir(), `__no_output_${Date.now()}__.md`) }),
    { snapshotted: false, dest: null },
  );
  // 缺 contractId / agentId / outputPath / lineage
  assert.deepEqual(await snapshotOutputToRunTree({ lineage: SNAPSHOT_LINEAGE, agentId: "a", outputPath: "/x.md" }), { snapshotted: false, dest: null });
  assert.deepEqual(await snapshotOutputToRunTree({ lineage: SNAPSHOT_LINEAGE, contractId: "tc-x", outputPath: "/x.md" }), { snapshotted: false, dest: null });
  assert.deepEqual(await snapshotOutputToRunTree({ lineage: SNAPSHOT_LINEAGE, contractId: "tc-x", agentId: "a" }), { snapshotted: false, dest: null });
  assert.deepEqual(await snapshotOutputToRunTree({ contractId: "tc-x", agentId: "a", outputPath: "/x.md" }), { snapshotted: false, dest: null });
  assert.deepEqual(await snapshotOutputToRunTree({}), { snapshotted: false, dest: null });
});

test("snapshotOutputToRunTree：内部抛错被吞（绝不破坏 agent_end）", async () => {
  // 传入非法 outputPath 类型不应抛（内部 try/catch 兜底）
  const result = await snapshotOutputToRunTree({ lineage: SNAPSHOT_LINEAGE, contractId: "tc-x", agentId: "a", outputPath: 12345 });
  assert.deepEqual(result, { snapshotted: false, dest: null }, "非法入参应 no-op 不抛");
});

// agent_end 接入点：cleanupAgentEndTransport 接入 snapshotOutputToRunTree 且包 try/catch
test("agent-end-transport：接入 snapshotOutputToRunTree 且包 try/catch（不破坏清理）", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("../lib/lifecycle/agent-end/transport.js", import.meta.url), "utf8");
  assert.match(src, /snapshotOutputToRunTree/, "应接入 snapshotOutputToRunTree");
  // outputPath 来源：executionObservation?.primaryOutputPath || trackingState?.contract?.output
  assert.match(src, /primaryOutputPath/, "outputPath 应取 executionObservation.primaryOutputPath");
  assert.match(src, /contract\?\.output/, "outputPath 兜底应取 trackingState.contract.output");
  // 产出件快照段包在 try/catch 内
  assert.match(src, /try\s*\{[\s\S]*snapshotOutputToRunTree[\s\S]*\}\s*catch/, "产出件快照应包在 try/catch 内");
});
