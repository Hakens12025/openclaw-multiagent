/**
 * workflow-page-backend.test.js — P-WF1 后端数据层
 *
 * 覆盖：
 *   1. computeAgentWorkflows 无向连通分量 + entry 推导（纯函数）
 *   2. inspect.agent_workflows surface 合规 + 经 surface 等价
 *   3. inspect.agent_sessions：倒序 / 字段 / 缺失兜底 / surface 合规
 *   4. inspect.session_transcript：消息解析 / 文件提取与解析 / persistent 判定 / surface 合规
 *   5. POST /watchdog/reveal-file：白名单内放行（mock exec）/ 白名单外 / .. 逃逸 / 405 / 401
 *   6. snapshotInboxToTrace：快照落盘 / 抛错不冒泡（cleanup 不被破坏）
 *   6b. snapshotOutputToTrace：产出件复制 / 覆盖 / 缺失 no-op / 抛错吞掉 / agent_end 接入
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
import { artifactDir, artifactPackageDir, ARTIFACT_MANIFEST_FILE } from "../lib/lifecycle/artifact-store.js";
import {
  revealFileInFinder,
  isPathWithinAllowedRoots,
} from "../lib/agent/agent-reveal-file.js";
import { snapshotInboxToTrace, snapshotOutputToTrace } from "../lib/lifecycle/workflow-trace-snapshot.js";

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
    const tr = await readSessionTranscript(agentId, sessionId, { contractId: "tc-xyz" });
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

    // referencedFiles：inbox contract（kind=contract，解析到 contracts 正本）
    const contractRef = tr.referencedFiles.find((f) => f.kind === "contract");
    assert.ok(contractRef, "应抽出 inbox contract 引用");
    assert.match(contractRef.resolvedPath, /control-plane\/contracts\/tc-xyz\.json$/, "应解析到 contracts 正本");

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
  // 正本用大写 TC-REAL.json,但 contractId 传小写 tc-real —— 验证大小写不敏感解析(sessionKey 会小写 contractId)
  const contractsDir = join(OC_ROOT, "control-plane", "contracts");
  await mkdir(contractsDir, { recursive: true });
  const contractFile = join(contractsDir, "TC-REAL.json");
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
    const tr = await readSessionTranscript(agentId, sessionId, { contractId: "tc-real" });
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
    // 小写 contractId(sessionKey 来)解析到正本;macOS 大小写不敏感 FS 下 existsSync 命中大写 TC-REAL.json,
    // 故 persistent=true、reveal(open -R)可打开(case-sensitive FS 下 resolveCaseInsensitive 扫到实际大小写)。
    assert.match(contractRef.resolvedPath, /control-plane\/contracts\/tc-real\.json$/i, "应解析到 contracts 正本(大小写不敏感)");
    assert.equal(contractRef.persistent, true, "正本存在(大小写不敏感命中)→ persistent=true → 可 reveal");
    const outputRef = tr.referencedFiles.find((f) => f.kind === "output" && f.resolvedPath.endsWith(outputName));
    assert.ok(outputRef, "应抽出 output 引用");
    assert.equal(outputRef.persistent, true, "output 正本存在 → persistent=true");
  } finally {
    await rm(join(OC_ROOT, "agents", agentId), { recursive: true, force: true });
    await rm(join(OC_ROOT, "workspaces", agentId), { recursive: true, force: true });
    await rm(outputPath, { force: true });
    await rm(contractFile, { force: true });
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
    assert.match(content, /Contract: `TC-OVERRIDE-1`/, "含合约 id");
  } finally {
    await rm(join(OC_ROOT, "agents", agentId), { recursive: true, force: true });
  }
});

test("readSessionTranscript：producedFiles 读持久产物包（artifacts/<cid>/<agent>/，含正文+主交付物）", async () => {
  const cid = `tc-produced-${Date.now()}`;
  const agentId = "planner";
  const dir = artifactPackageDir(cid, agentId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "report.md"), "# 报告正文", "utf8");
  await writeFile(join(dir, "data.json"), '{"k":1}', "utf8");
  await writeFile(join(dir, ARTIFACT_MANIFEST_FILE), JSON.stringify({
    contractId: cid, producer: agentId, producedAt: "2026-01-01T00:00:00.000Z",
    primary: "report.md", files: ["report.md", "data.json"],
  }), "utf8");
  try {
    const tr = await readSessionTranscript(agentId, "__nofile__", { contractId: cid });
    assert.equal(tr.producedFiles.available, true, "产物包应可用");
    assert.equal(tr.producedFiles.files.length, 2, "两个产物文件（manifest 不计入）");
    const report = tr.producedFiles.files.find((f) => f.name === "report.md");
    assert.ok(report, "应含 report.md");
    assert.equal(report.primary, true, "report.md 是主交付物");
    assert.equal(report.content, "# 报告正文", "正文应内显");
    assert.equal(tr.producedFiles.files[0].name, "report.md", "主交付物应排前");
    assert.equal(tr.producedFiles.manifest.producer, agentId);
  } finally {
    await rm(artifactDir(cid), { recursive: true, force: true });
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

test("revealFileInFinder：白名单内放行（mock exec，不真跑 open）", async () => {
  let captured = null;
  const exec = (cmd, args, cb) => { captured = { cmd, args }; cb(null); };
  const target = join(OC_ROOT, "control-plane", "output", "x.md");
  const result = await revealFileInFinder(target, { exec });
  assert.deepEqual(result, { ok: true, resolvedPath: target });
  assert.equal(captured.cmd, "open");
  assert.deepEqual(captured.args, ["-R", target], "应 execFile open -R <path>（无 shell）");
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
  registerApiRoutes(api, logger, { enqueueFn() {}, wakePlanner() {} });
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

// ── 6. snapshotInboxToTrace ────────────────────────────────────────────────────

test("snapshotInboxToTrace：有 contractId 时快照 inbox 文件落到 trace 目录", async () => {
  const srcRoot = await mkdtemp(join(tmpdir(), "wf-inbox-"));
  await writeFile(join(srcRoot, "contract.json"), JSON.stringify({ id: "tc-snap" }), "utf8");
  await writeFile(join(srcRoot, "note.md"), "hi", "utf8");

  const contractId = `tc-snap-${Date.now()}`;
  const agentId = "worker-snap";
  const traceBase = join(OC_ROOT, "control-plane", "workflow-trace", contractId);
  try {
    const result = await snapshotInboxToTrace({ contractId, agentId, inboxDir: srcRoot });
    assert.equal(result.snapshotted, true);
    const { existsSync, readFileSync } = await import("node:fs");
    const dest = join(traceBase, agentId, "inbox");
    assert.equal(existsSync(join(dest, "contract.json")), true, "contract.json 应被快照");
    assert.equal(existsSync(join(dest, "note.md")), true, "note.md 应被快照");
    assert.equal(readFileSync(join(dest, "note.md"), "utf8"), "hi");
  } finally {
    await rm(srcRoot, { recursive: true, force: true });
    await rm(traceBase, { recursive: true, force: true });
  }
});

test("snapshotInboxToTrace：缺 contractId / agentId / inboxDir → no-op（不抛）", async () => {
  assert.deepEqual(await snapshotInboxToTrace({ agentId: "a", inboxDir: "/x" }), { snapshotted: false, dest: null });
  assert.deepEqual(await snapshotInboxToTrace({ contractId: "c", inboxDir: "/x" }), { snapshotted: false, dest: null });
  assert.deepEqual(await snapshotInboxToTrace({ contractId: "c", agentId: "a" }), { snapshotted: false, dest: null });
  assert.deepEqual(await snapshotInboxToTrace({}), { snapshotted: false, dest: null });
});

test("snapshotInboxToTrace：源不存在时抛错（由调用方 try/catch 吞掉，验证不破坏 cleanup 契约）", async () => {
  // 源目录不存在 → cp 抛错。验证错误冒泡到调用方（调用方负责吞）。
  await assert.rejects(
    () => snapshotInboxToTrace({
      contractId: "tc-missing",
      agentId: "w",
      inboxDir: join(tmpdir(), `__never_exists_${Date.now()}__`),
    }),
    "源不存在应抛错（调用方 try/catch 兜底，不影响 unlink）",
  );
});

// cleanup 接入点：cleanupAgentEndTransport 包了 try/catch，快照抛错不冒泡
test("agent-end-transport：快照调用包在 try/catch（快照失败不破坏清理）", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("../lib/lifecycle/agent-end-transport.js", import.meta.url), "utf8");
  assert.match(src, /snapshotInboxToTrace/, "应接入 snapshotInboxToTrace");
  // 快照调用必须在 cleanInbox（unlink 发生处）之前
  const snapIdx = src.indexOf("snapshotInboxToTrace");
  const cleanIdx = src.indexOf("await cleanInbox");
  assert.ok(snapIdx >= 0 && cleanIdx >= 0 && snapIdx < cleanIdx, "快照必须在 cleanInbox 之前");
  // 快照段必须在 try/catch 内
  assert.match(src, /try\s*\{[\s\S]*snapshotInboxToTrace[\s\S]*\}\s*catch/, "快照应包在 try/catch 内");
});

// ── 6b. snapshotOutputToTrace（产出件快照）────────────────────────────────────

test("snapshotOutputToTrace：复制产出件到 workflow-trace/<cid>/output.md", async () => {
  const srcRoot = await mkdtemp(join(tmpdir(), "wf-output-"));
  const outputPath = join(srcRoot, "tc-x.md");
  await writeFile(outputPath, "用户最终件", "utf8");

  const contractId = `tc-outsnap-${Date.now()}`;
  const traceBase = join(OC_ROOT, "control-plane", "workflow-trace", contractId);
  try {
    const result = await snapshotOutputToTrace({ contractId, outputPath });
    assert.equal(result.snapshotted, true);
    const { existsSync, readFileSync } = await import("node:fs");
    const dest = join(traceBase, "output.md");
    assert.equal(result.dest, dest, "dest 应为 workflow-trace/<cid>/output.md");
    assert.equal(existsSync(dest), true, "产出件应被快照");
    assert.equal(readFileSync(dest, "utf8"), "用户最终件");
  } finally {
    await rm(srcRoot, { recursive: true, force: true });
    await rm(traceBase, { recursive: true, force: true });
  }
});

test("snapshotOutputToTrace：覆盖写（last-writer-wins，末位 agent 跑完即最终件）", async () => {
  const srcRoot = await mkdtemp(join(tmpdir(), "wf-output-"));
  const outputPath = join(srcRoot, "tc-x.md");
  const contractId = `tc-outover-${Date.now()}`;
  const traceBase = join(OC_ROOT, "control-plane", "workflow-trace", contractId);
  try {
    await writeFile(outputPath, "FIRST", "utf8");
    await snapshotOutputToTrace({ contractId, outputPath });
    await writeFile(outputPath, "SECOND", "utf8");
    await snapshotOutputToTrace({ contractId, outputPath });
    const { readFileSync } = await import("node:fs");
    assert.equal(readFileSync(join(traceBase, "output.md"), "utf8"), "SECOND", "应覆盖为最新内容");
  } finally {
    await rm(srcRoot, { recursive: true, force: true });
    await rm(traceBase, { recursive: true, force: true });
  }
});

test("snapshotOutputToTrace：产出件不存在 / 缺 contractId → no-op（不抛）", async () => {
  // 产出件不存在
  assert.deepEqual(
    await snapshotOutputToTrace({ contractId: "tc-x", outputPath: join(tmpdir(), `__no_output_${Date.now()}__.md`) }),
    { snapshotted: false, dest: null },
  );
  // 缺 contractId / outputPath
  assert.deepEqual(await snapshotOutputToTrace({ outputPath: "/x.md" }), { snapshotted: false, dest: null });
  assert.deepEqual(await snapshotOutputToTrace({ contractId: "tc-x" }), { snapshotted: false, dest: null });
  assert.deepEqual(await snapshotOutputToTrace({}), { snapshotted: false, dest: null });
});

test("snapshotOutputToTrace：内部抛错被吞（绝不破坏 agent_end）", async () => {
  // 传入非法 outputPath 类型不应抛（内部 try/catch 兜底）
  const result = await snapshotOutputToTrace({ contractId: "tc-x", outputPath: 12345 });
  assert.deepEqual(result, { snapshotted: false, dest: null }, "非法入参应 no-op 不抛");
});

// agent_end 接入点：cleanupAgentEndTransport 接入 snapshotOutputToTrace 且包 try/catch
test("agent-end-transport：接入 snapshotOutputToTrace 且包 try/catch（不破坏清理）", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("../lib/lifecycle/agent-end-transport.js", import.meta.url), "utf8");
  assert.match(src, /snapshotOutputToTrace/, "应接入 snapshotOutputToTrace");
  // outputPath 来源：executionObservation?.primaryOutputPath || trackingState?.contract?.output
  assert.match(src, /primaryOutputPath/, "outputPath 应取 executionObservation.primaryOutputPath");
  assert.match(src, /contract\?\.output/, "outputPath 兜底应取 trackingState.contract.output");
  // 产出件快照段包在 try/catch 内
  assert.match(src, /try\s*\{[\s\S]*snapshotOutputToTrace[\s\S]*\}\s*catch/, "产出件快照应包在 try/catch 内");
});
