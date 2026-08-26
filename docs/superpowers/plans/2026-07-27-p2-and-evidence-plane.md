# P2 授权单源 + 证据面主干 · 实施计划(批次一)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 spec(2026-07-27-unified-fc-evidence-plane-design.md)第一批:协作意图授权单一真源(P2)+ 证据面主干(桥/账本/完整性),全程不碰传送带。

**Architecture:** Part A 新建 `collaboration-intent-policy.js` 单源表,role-policy 矩阵改为派生,删幽灵 intent resume_finalization,收回 planner 的 advance_loop。Part B 新建 `lib/evidence/`(schema/digest/store/bridge 四模块),桥挂 after_tool_call(ok/error)与 before_tool_call 包裹层(refused),open/close 哨兵挂 before_agent_start/agent_end。证据写入永不阻塞执行(bridge 内部吞错)。

**Tech Stack:** Node ESM · node:test + assert/strict(`npm test` 串行)· appendFile jsonl · 现有 CONTROL_PLANE_PATHS/security.js 复用。

**Block 纪律:** 每个 commit 前用 `node scripts/openclaw-block-check.js --primary <id>` 过闸(检查的是 git 未提交文件,故**按块分 commit**)。本批 primary 分布:protocol/control-plane/core/lib-evidence→`runtime-core`;lib/system-action→`operator-cli-control`;hooks→`local-execution`;lib/security 归属未知,commit 前先跑 check 按报告归块;tests/docs/registry→support 不影响。

---

## Part A · P2 授权单源

### Task A1a: 删 resume_finalization(protocol 侧)

**Files:** Modify `lib/protocol/protocol-primitives.js:28`;Modify `tests/loop-protocol-pruning.test.js`

- [ ] **A1a-1** 在 `tests/loop-protocol-pruning.test.js` 首个 test 内加负向断言(仿照该文件既有 start_pipeline 断言风格):

```js
assert.equal("RESUME_FINALIZATION" in INTENT_TYPES, false);
assert.equal(isKnownIntentType("resume_finalization"), false);
```

- [ ] **A1a-2** 跑 `npm test -- 2>&1 | tail -20`?否——单测该文件:`node --test tests/loop-protocol-pruning.test.js`。预期:FAIL(断言 RESUME_FINALIZATION 仍在)。
- [ ] **A1a-3** 删 `lib/protocol/protocol-primitives.js` L28 一行:`RESUME_FINALIZATION: "resume_finalization",`
- [ ] **A1a-4** `node --test tests/loop-protocol-pruning.test.js` 预期 PASS。
- [ ] **A1a-5** `node scripts/openclaw-block-check.js --primary runtime-core` 预期 ok → commit:

```bash
git add lib/protocol/protocol-primitives.js tests/loop-protocol-pruning.test.js
git commit -m "refactor(protocol): remove ghost intent resume_finalization from INTENT_TYPES (spec decision 27)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task A1b: 删 resume_finalization(ledger 死分支)

**Files:** Modify `lib/system-action/system-action-runtime-ledger.js:56-69`

- [ ] **A1b-1** 删除 `buildDeferredSystemActionFollowUp` 内整个 `if (systemActionResult.actionType === INTENT_TYPES.RESUME_FINALIZATION) { ... }` 分支(14 行)。保留 imports:ARTIFACT_TYPES(L77/L88 仍用)、inferSemanticWorkflow(CREATE_TASK/ASSIGN_TASK 分支仍用)。
- [ ] **A1b-2** `node --test tests/loop-protocol-pruning.test.js tests/system-action-role-policy.test.js` 预期 PASS(死分支删除无行为变化)。
- [ ] **A1b-3** `node scripts/openclaw-block-check.js --primary operator-cli-control` → commit `refactor(system-action): drop dead resume_finalization follow-up branch`(同款尾注)。

### Task A2: collaboration-intent-policy 单源表 + planner advance_loop 收回

**Files:** Create `lib/system-action/collaboration-intent-policy.js`;Modify `lib/system-action/system-action-role-policy.js`(矩阵改派生);Modify `lib/system-action/system-action-runtime.js`(export listRuntimeHandledIntents);Modify `tests/system-action-role-policy.test.js`(planner 断言);Create `tests/collaboration-intent-policy.test.js`

- [ ] **A2-1** 新建 `tests/collaboration-intent-policy.test.js`(先写失败测试):

```js
import test from "node:test";
import assert from "node:assert/strict";

import { AGENT_ROLE } from "../lib/agent/agent-metadata.js";
import { INTENT_TYPES } from "../lib/protocol/protocol-primitives.js";
import {
  COLLABORATION_INTENT_POLICY,
  listExposedToolIntents,
  listRolesForIntent,
} from "../lib/system-action/collaboration-intent-policy.js";
import {
  isActionAllowedForRole,
  listAllowedActionTypesForRole,
} from "../lib/system-action/system-action-role-policy.js";
import { listRuntimeHandledIntents } from "../lib/system-action/system-action-runtime.js";

test("every policy intent is a registered INTENT_TYPES value", () => {
  const known = new Set(Object.values(INTENT_TYPES));
  for (const row of COLLABORATION_INTENT_POLICY) {
    assert.ok(known.has(row.intent), `unknown intent in policy: ${row.intent}`);
  }
});

test("policy runtimeHandler flags agree with RUNTIME_SYSTEM_ACTION_HANDLERS", () => {
  const handled = new Set(listRuntimeHandledIntents());
  for (const row of COLLABORATION_INTENT_POLICY) {
    assert.equal(handled.has(row.intent), row.runtimeHandler,
      `runtimeHandler mismatch for ${row.intent}`);
  }
});

test("v1 tool face exposes exactly assign_task/wake_agent/request_review", () => {
  assert.deepEqual(listExposedToolIntents().sort(),
    ["assign_task", "request_review", "wake_agent"]);
});

test("role matrix is derived from the policy table (single source)", () => {
  for (const row of COLLABORATION_INTENT_POLICY) {
    for (const role of Object.values(AGENT_ROLE)) {
      assert.equal(
        isActionAllowedForRole(role, row.intent),
        listRolesForIntent(row.intent).includes(role),
        `matrix/policy disagree: ${role} × ${row.intent}`,
      );
    }
  }
});

test("planner may no longer advance_loop (spec decision 26)", () => {
  assert.equal(isActionAllowedForRole(AGENT_ROLE.PLANNER, "advance_loop"), false);
  assert.deepEqual(listAllowedActionTypesForRole(AGENT_ROLE.PLANNER).sort(),
    ["assign_task", "request_review"]);
});
```

- [ ] **A2-2** `node --test tests/collaboration-intent-policy.test.js` 预期 FAIL(模块不存在)。
- [ ] **A2-3** 新建 `lib/system-action/collaboration-intent-policy.js`:

```js
// collaboration-intent-policy.js — single source of truth for collaboration
// intents (spec §5 / P2): one row per intent unifies the intent vocabulary,
// role authorization, runtime-handler expectation, and v1 tool-face exposure.
// system-action-role-policy.js derives its role matrix from this table.

import { AGENT_ROLE } from "../agent/agent-metadata.js";
import { INTENT_TYPES } from "../protocol/protocol-primitives.js";

const { BRIDGE, PLANNER, EXECUTOR, RESEARCHER, REVIEWER, AGENT } = AGENT_ROLE;

export const COLLABORATION_INTENT_POLICY = Object.freeze([
  Object.freeze({
    intent: INTENT_TYPES.ASSIGN_TASK,
    roles: Object.freeze([BRIDGE, PLANNER, AGENT]),
    exposedAsTool: true,
    runtimeHandler: true,
  }),
  Object.freeze({
    intent: INTENT_TYPES.REQUEST_REVIEW,
    roles: Object.freeze([PLANNER, EXECUTOR, RESEARCHER, REVIEWER, AGENT]),
    exposedAsTool: true,
    runtimeHandler: true,
  }),
  Object.freeze({
    intent: INTENT_TYPES.WAKE_AGENT,
    roles: Object.freeze([AGENT]),
    exposedAsTool: true,
    runtimeHandler: true,
  }),
  // Deferred build (spec §5): no role may issue create_task yet; intent stays
  // in the vocabulary so the L3 text channel keeps parsing it as known-but-denied.
  Object.freeze({
    intent: INTENT_TYPES.CREATE_TASK,
    roles: Object.freeze([]),
    exposedAsTool: false,
    runtimeHandler: true,
  }),
  // Orchestration power (spec §5): never exposed as tools. start_loop has no
  // runtime handler — systemActionConsume's switch owns it.
  Object.freeze({
    intent: INTENT_TYPES.START_LOOP,
    roles: Object.freeze([AGENT]),
    exposedAsTool: false,
    runtimeHandler: false,
  }),
  // planner revoked per spec decision 26: loop advancement belongs to the loop
  // runtime, not to any planning role.
  Object.freeze({
    intent: INTENT_TYPES.ADVANCE_LOOP,
    roles: Object.freeze([REVIEWER, AGENT]),
    exposedAsTool: false,
    runtimeHandler: true,
  }),
]);

export function listExposedToolIntents() {
  return COLLABORATION_INTENT_POLICY
    .filter((row) => row.exposedAsTool)
    .map((row) => row.intent);
}

export function listRolesForIntent(intentType) {
  const row = COLLABORATION_INTENT_POLICY.find((r) => r.intent === intentType);
  return row ? [...row.roles] : [];
}

export function deriveRoleActionMatrix() {
  const matrix = {};
  for (const role of Object.values(AGENT_ROLE)) {
    matrix[role] = Object.freeze(
      COLLABORATION_INTENT_POLICY
        .filter((row) => row.roles.includes(role))
        .map((row) => row.intent),
    );
  }
  return Object.freeze(matrix);
}
```

- [ ] **A2-4** 改 `lib/system-action/system-action-role-policy.js`:删除手写 `ROLE_ACTION_MATRIX` 字面量(L24-50),替换为派生;头注释的 canonical 矩阵表同步改(planner 行去掉 advance_loop,并注明真源已移至 collaboration-intent-policy.js);`SYSTEM_ACTION_TYPES` 与四个查询函数(isActionAllowedForRole/listAllowedActionTypesForRole/resolveDisallowedActionReason/SYSTEM_ACTION_ROLE_POLICY)签名保持不变:

```js
import { deriveRoleActionMatrix } from "./collaboration-intent-policy.js";

const ROLE_ACTION_MATRIX = deriveRoleActionMatrix();
```

- [ ] **A2-5** 改 `lib/system-action/system-action-runtime.js`:在 RUNTIME_SYSTEM_ACTION_HANDLERS 定义后加:

```js
export function listRuntimeHandledIntents() {
  return Object.keys(RUNTIME_SYSTEM_ACTION_HANDLERS);
}
```

- [ ] **A2-6** 改 `tests/system-action-role-policy.test.js`:planner 断言从含 advance_loop 改为 `["assign_task","request_review"]`(保持原断言风格 `.sort()` 对比)。
- [ ] **A2-7** `node --test tests/collaboration-intent-policy.test.js tests/system-action-role-policy.test.js tests/loop-protocol-pruning.test.js tests/advance-loop-no-kill.test.js` 预期全 PASS。
- [ ] **A2-8** block-check `--primary operator-cli-control` → commit `feat(system-action): collaboration-intent-policy single source; revoke planner advance_loop`。

### Task A3: 全量回归(Part A 收口)

- [ ] **A3-1** `npm test` 后台跑,预期 1588+新增 全绿(唯一容忍失败=已知 flaky error-ledger-sibling)。
- [ ] **A3-2** `node ~/.openclaw/extensions/watchdog/test-runner.js`(health 预设,零 LLM)预期 70/70。

---

## Part B · 证据面主干

### Task B0: 路径与 block 归类地基

**Files:** Modify `lib/control-plane/control-plane-paths.js`;Modify `lib/dev/system-block-registry.js`

- [ ] **B0-1** `control-plane-paths.js` 的 CONTROL_PLANE_PATHS 冻结字面量内加一行(Dir 后缀惯例):`traceDir: join(CONTROL_PLANE_ROOT, "trace"),`
- [ ] **B0-2** `system-block-registry.js` runtime-core patterns 数组加:`/^extensions\/watchdog\/lib\/evidence\//,`
- [ ] **B0-3** block-check `--primary runtime-core` → commit `chore(evidence): trace dir path + block registry pattern`。

### Task B1: trace-event-schema(纯逻辑)

**Files:** Create `lib/evidence/trace-event-schema.js`;Create `tests/trace-event-schema.test.js`

- [ ] **B1-1** 测试先行 `tests/trace-event-schema.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";

import {
  TRACE_EVENT_KINDS,
  TRACE_EVENT_CHANNELS,
  TRACE_EVENT_OUTCOMES,
  TRACE_SENTINELS,
  isLegalKindChannel,
  buildTraceEvent,
} from "../lib/evidence/trace-event-schema.js";

test("kind×channel legality matrix: internal only allows fc", () => {
  assert.equal(isLegalKindChannel("internal", "fc"), true);
  assert.equal(isLegalKindChannel("internal", "fence"), false);
  assert.equal(isLegalKindChannel("internal", "text"), false);
  assert.equal(isLegalKindChannel("collab", "fc"), true);
  assert.equal(isLegalKindChannel("collab", "fence"), true);
  assert.equal(isLegalKindChannel("collab", "text"), true);
});

test("buildTraceEvent rejects illegal combinations and unknown outcomes", () => {
  assert.throws(() => buildTraceEvent({
    kind: "internal", channel: "text", name: "write",
    outcome: "ok", sessionKey: "s",
  }), /illegal trace event/);
  assert.throws(() => buildTraceEvent({
    kind: "internal", channel: "fc", name: "write",
    outcome: "maybe", sessionKey: "s",
  }), /unknown trace outcome/);
});

test("buildTraceEvent produces a well-formed internal fc event", () => {
  const evt = buildTraceEvent({
    kind: TRACE_EVENT_KINDS.INTERNAL,
    channel: TRACE_EVENT_CHANNELS.FC,
    name: "write",
    argsDigest: { path: "/tmp/x.md", bytes: 12 },
    resultDigest: { bytes: 3 },
    outcome: TRACE_EVENT_OUTCOMES.OK,
    agentId: "worker",
    sessionKey: "agent:worker:c:TC-1",
    contractId: "TC-1",
  });
  assert.equal(evt.kind, "internal");
  assert.equal(evt.contractId, "TC-1");
  assert.ok(Number.isFinite(evt.ts));
  assert.equal(TRACE_SENTINELS.OPEN, "session_open");
});
```

- [ ] **B1-2** 跑测:预期 FAIL(模块不存在)。
- [ ] **B1-3** 新建 `lib/evidence/trace-event-schema.js`:

```js
// trace-event-schema.js — unified FC evidence event shape (spec §2).
// Two orthogonal tags: kind (which execution path) × channel (which
// expression inlet). Illegal combinations are rejected at build time.

export const TRACE_EVENT_KINDS = Object.freeze({
  INTERNAL: "internal",
  COLLAB: "collab",
});

export const TRACE_EVENT_CHANNELS = Object.freeze({
  FC: "fc",
  FENCE: "fence",
  TEXT: "text",
});

export const TRACE_EVENT_OUTCOMES = Object.freeze({
  OK: "ok",
  REFUSED: "refused",
  ERROR: "error",
});

export const TRACE_SENTINELS = Object.freeze({
  OPEN: "session_open",
  CLOSE: "session_close",
});

const LEGAL_CHANNELS = Object.freeze({
  [TRACE_EVENT_KINDS.INTERNAL]: Object.freeze([TRACE_EVENT_CHANNELS.FC]),
  [TRACE_EVENT_KINDS.COLLAB]: Object.freeze([
    TRACE_EVENT_CHANNELS.FC, TRACE_EVENT_CHANNELS.FENCE, TRACE_EVENT_CHANNELS.TEXT,
  ]),
});

export function isLegalKindChannel(kind, channel) {
  return (LEGAL_CHANNELS[kind] || []).includes(channel);
}

export function buildTraceEvent({
  kind, channel, name,
  argsDigest = null, resultDigest = null,
  outcome, agentId = "unknown", sessionKey,
  contractId = null, synthesized = false, ts = Date.now(),
} = {}) {
  if (!isLegalKindChannel(kind, channel)) {
    throw new TypeError(`illegal trace event kind/channel: ${kind}/${channel}`);
  }
  if (!Object.values(TRACE_EVENT_OUTCOMES).includes(outcome)) {
    throw new TypeError(`unknown trace outcome: ${outcome}`);
  }
  if (!name || !sessionKey) {
    throw new TypeError("trace event requires name and sessionKey");
  }
  return {
    kind, channel, name,
    args: argsDigest, result: resultDigest,
    outcome, agentId, sessionKey,
    ...(contractId ? { contractId } : {}),
    ...(synthesized ? { synthesized: true } : {}),
    ts,
  };
}
```

- [ ] **B1-4** 跑测 PASS → commit `feat(evidence): trace event schema (kind×channel matrix)` primary runtime-core。

### Task B2: 摘要与脱敏

**Files:** Modify `lib/security/security.js`(新增一个 export);Create `lib/evidence/tool-event-digest.js`;Create `tests/tool-event-digest.test.js`

- [ ] **B2-1** `lib/security/security.js` 在 containsApiKey 之后新增(复用同一份 API_KEY_PATTERNS,单规则源两消费者):

```js
// Redaction reuses the SAME pattern truth as the block checks (spec §2):
// one rule source, two consumers (block + redact).
export function redactSensitiveText(text) {
  let out = String(text ?? "");
  for (const pattern of API_KEY_PATTERNS) {
    const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
    out = out.replace(new RegExp(pattern.source, flags), "[REDACTED]");
  }
  return out;
}
```

- [ ] **B2-2** 测试先行 `tests/tool-event-digest.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";

import { digestToolArgs, digestToolResult } from "../lib/evidence/tool-event-digest.js";

test("write digest keeps path/bytes/hash and never raw content", () => {
  const digest = digestToolArgs("write", { path: "/tmp/r.md", content: "hello world" });
  assert.equal(digest.path, "/tmp/r.md");
  assert.equal(digest.bytes, 11);
  assert.match(digest.hash, /^[0-9a-f]{64}$/);
  assert.equal("content" in digest, false);
});

test("bash digest clips command and redacts api keys", () => {
  const digest = digestToolArgs("bash", {
    command: `curl -H "Authorization: sk-${"a".repeat(24)}" https://x`,
  });
  assert.ok(digest.command.includes("[REDACTED]"));
  assert.equal(digest.command.includes("sk-a"), false);
});

test("unknown tools fall back to key names only", () => {
  const digest = digestToolArgs("mystery_tool", { secretPayload: "xxx", n: 1 });
  assert.deepEqual(digest, { keys: ["secretPayload", "n"] });
});

test("result digest records error text (redacted) or byte count", () => {
  assert.match(digestToolResult({ error: "boom" }).error, /boom/);
  const ok = digestToolResult({ result: { content: [{ type: "text", text: "abcd" }] } });
  assert.ok(Number.isFinite(ok.bytes));
});
```

- [ ] **B2-3** 跑测 FAIL → 新建 `lib/evidence/tool-event-digest.js`:

```js
// tool-event-digest.js — per-tool args/result digesters (spec §2).
// One registry row per tool; conservative default never dumps raw args.
// Collab tools are NOT digested here (their args are the evidence and are
// stored whole by the collab tool handlers — later batch).

import { createHash } from "node:crypto";
import { collectWriteContent, redactSensitiveText } from "../security/security.js";
import { measureToolResultBytes } from "../delivery/runtime-user-facing-output.js";

// same content-addressed inline pattern as wiki-rag-store.js
function sha256Hex(text) {
  return createHash("sha256").update(String(text || "")).digest("hex");
}

function clip(value, limit = 200) {
  const normalized = String(value ?? "").trim();
  return normalized.length > limit ? `${normalized.slice(0, limit)}…` : normalized;
}

function toolPath(params) {
  return String(params.path ?? params.file_path ?? params.filePath ?? "");
}

function writeDigest(params) {
  const content = collectWriteContent(params);
  return {
    path: toolPath(params),
    bytes: Buffer.byteLength(content || "", "utf8"),
    ...(content ? { hash: sha256Hex(content) } : {}),
  };
}

function execDigest(params) {
  return { command: redactSensitiveText(clip(params.command ?? params.cmd)) };
}

const DIGESTERS = Object.freeze({
  write: writeDigest, edit: writeDigest, create: writeDigest,
  apply_patch: writeDigest, multi_edit: writeDigest,
  read: (params) => ({ path: toolPath(params) }),
  bash: execDigest, exec: execDigest,
  glob: (params) => ({ pattern: clip(params.pattern) }),
  grep: (params) => ({ pattern: clip(params.pattern) }),
  web_search: (params) => ({ query: clip(params.query ?? params.q) }),
  web_fetch: (params) => ({ url: clip(params.url) }),
  sessions_send: (params) => ({
    target: clip(params.targetAgent ?? params.agentId ?? params.target ?? params.agent),
  }),
});

export function digestToolArgs(toolName, params = {}) {
  const digester = DIGESTERS[String(toolName || "").toLowerCase()];
  if (digester) return digester(params);
  return { keys: Object.keys(params).slice(0, 12) };
}

export function digestToolResult(event = {}) {
  if (event.error) {
    return { error: redactSensitiveText(clip(event.error?.message ?? event.error)) };
  }
  return { bytes: measureToolResultBytes(event) };
}
```

- [ ] **B2-4** 跑测 PASS;既有安全测试回归 `node --test tests/security-write-apikey-scan.test.js tests/security-block-reason.test.js` PASS。
- [ ] **B2-5** 两个 commit(按块):先 `lib/security/security.js`(commit 前跑 block-check 确认其归属块并以之为 primary),后 `lib/evidence/tool-event-digest.js + tests`(primary runtime-core)。

### Task B3: session-trace-store(账本)

**Files:** Create `lib/evidence/session-trace-store.js`;Create `tests/session-trace-store.test.js`

- [ ] **B3-1** 测试先行(env 覆盖目录惯例,resolveTraceDir 每次调用读 env,无需 cachebust):

```js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  openSessionTrace, appendTraceEvent, closeSessionTrace,
  sessionTraceFile, validateSessionTraceContent, clearSessionTraceMemory,
} from "../lib/evidence/session-trace-store.js";
import { buildTraceEvent } from "../lib/evidence/trace-event-schema.js";

test.afterEach(() => { clearSessionTraceMemory(); });

test("open → append → close produces a contiguous hash-chained episode", async () => {
  const dir = await mkdtemp(join(tmpdir(), "session-trace-"));
  process.env.OPENCLAW_TRACE_DIR = dir;
  const sessionKey = "agent:worker:c:TC-9";
  try {
    await openSessionTrace(sessionKey, { agentId: "worker", contractId: "TC-9" });
    await appendTraceEvent(sessionKey, buildTraceEvent({
      kind: "internal", channel: "fc", name: "write",
      argsDigest: { path: "/tmp/x" }, outcome: "ok",
      agentId: "worker", sessionKey,
    }));
    await closeSessionTrace(sessionKey, { success: true });

    const content = await readFile(sessionTraceFile(sessionKey), "utf8");
    const records = content.trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(records.length, 3);
    assert.deepEqual(records.map((r) => r.seq), [0, 1, 2]);
    assert.equal(records[0].kind, "session_open");
    assert.equal(records[2].kind, "session_close");
    assert.equal(records[1].prevHash, records[0].hash);
    assert.equal(records[2].eventCount, 3);

    const verdict = validateSessionTraceContent(content);
    assert.equal(verdict.complete, true);
  } finally {
    delete process.env.OPENCLAW_TRACE_DIR;
    await rm(dir, { recursive: true, force: true });
  }
});

test("missing close sentinel → incomplete; torn last line → incomplete", async () => {
  const dir = await mkdtemp(join(tmpdir(), "session-trace-"));
  process.env.OPENCLAW_TRACE_DIR = dir;
  const sessionKey = "agent:worker:c:TC-10";
  try {
    await openSessionTrace(sessionKey, { agentId: "worker" });
    const open = await readFile(sessionTraceFile(sessionKey), "utf8");
    assert.equal(validateSessionTraceContent(open).complete, false);

    await writeFile(sessionTraceFile(sessionKey), `${open}{"seq":1,"kind":"int`, "utf8");
    const torn = await readFile(sessionTraceFile(sessionKey), "utf8");
    const verdict = validateSessionTraceContent(torn);
    assert.equal(verdict.complete, false);
    assert.match(verdict.reason, /torn|parse/i);
  } finally {
    delete process.env.OPENCLAW_TRACE_DIR;
    await rm(dir, { recursive: true, force: true });
  }
});
```

- [ ] **B3-2** 跑测 FAIL → 新建 `lib/evidence/session-trace-store.js`:

```js
// session-trace-store.js — append-only per-session evidence ledger (spec §3).
// jsonl via fs appendFile (single writer per session); open/seq/close
// sentinels + hash chain give structural self-proof of completeness.
// Callers must treat every export as non-critical: evidence failures are
// swallowed by the bridge layer and must never block execution.

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { CONTROL_PLANE_PATHS } from "../control-plane/control-plane-paths.js";
import { TRACE_SENTINELS } from "./trace-event-schema.js";

const TRACE_VERSION = 1;
const sessions = new Map(); // sessionKey -> { seq, lastHash }

function sha256Hex(text) {
  return createHash("sha256").update(String(text || "")).digest("hex");
}

function resolveTraceDir() {
  return process.env.OPENCLAW_TRACE_DIR || CONTROL_PLANE_PATHS.traceDir;
}

export function sessionTraceFile(sessionKey) {
  const safe = String(sessionKey || "").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
  if (!safe) throw new Error("invalid sessionKey for trace file");
  return join(resolveTraceDir(), `${safe}-${sha256Hex(sessionKey).slice(0, 8)}.jsonl`);
}

async function loadSessionState(sessionKey) {
  if (sessions.has(sessionKey)) return sessions.get(sessionKey);
  let state = { seq: -1, lastHash: null };
  try {
    const content = await readFile(sessionTraceFile(sessionKey), "utf8");
    const lines = content.trimEnd().split("\n").filter(Boolean);
    const last = JSON.parse(lines[lines.length - 1]);
    state = {
      seq: Number.isInteger(last.seq) ? last.seq : -1,
      lastHash: typeof last.hash === "string" ? last.hash : null,
    };
  } catch {
    // no file yet, or torn tail — start fresh; the validator will surface gaps.
  }
  sessions.set(sessionKey, state);
  return state;
}

async function appendRecord(sessionKey, record) {
  const state = await loadSessionState(sessionKey);
  const entry = {
    seq: state.seq + 1,
    traceVersion: TRACE_VERSION,
    ...record,
    prevHash: state.lastHash,
  };
  entry.hash = sha256Hex(JSON.stringify({ ...entry, hash: undefined }));
  await mkdir(resolveTraceDir(), { recursive: true });
  await appendFile(sessionTraceFile(sessionKey), `${JSON.stringify(entry)}\n`, "utf8");
  sessions.set(sessionKey, { seq: entry.seq, lastHash: entry.hash });
  return entry;
}

export async function openSessionTrace(sessionKey, { agentId = "unknown", contractId = null } = {}) {
  return appendRecord(sessionKey, {
    kind: TRACE_SENTINELS.OPEN,
    sessionKey, agentId,
    ...(contractId ? { contractId } : {}),
    ts: Date.now(),
  });
}

export async function appendTraceEvent(sessionKey, event) {
  return appendRecord(sessionKey, event);
}

export async function closeSessionTrace(sessionKey, { success = null } = {}) {
  const state = await loadSessionState(sessionKey);
  const entry = await appendRecord(sessionKey, {
    kind: TRACE_SENTINELS.CLOSE,
    sessionKey,
    ...(success === null ? {} : { success }),
    eventCount: state.seq + 2,
    ts: Date.now(),
  });
  sessions.delete(sessionKey);
  return entry;
}

export function validateSessionTraceContent(content) {
  const lines = String(content || "").split("\n").filter(Boolean);
  if (!lines.length) return { complete: false, reason: "empty trace", records: [] };
  const records = [];
  for (const line of lines) {
    try {
      records.push(JSON.parse(line));
    } catch {
      return { complete: false, reason: "torn/unparseable line", records };
    }
  }
  for (let i = 0; i < records.length; i++) {
    if (records[i].seq !== i) {
      return { complete: false, reason: `seq gap at ${i}`, records };
    }
    if (i > 0 && records[i].prevHash !== records[i - 1].hash) {
      return { complete: false, reason: `hash chain break at ${i}`, records };
    }
  }
  if (records[0].kind !== TRACE_SENTINELS.OPEN) {
    return { complete: false, reason: "missing open sentinel", records };
  }
  if (records[records.length - 1].kind !== TRACE_SENTINELS.CLOSE) {
    return { complete: false, reason: "missing close sentinel", records };
  }
  return { complete: true, reason: null, records };
}

export function clearSessionTraceMemory() {
  sessions.clear();
}
```

- [ ] **B3-3** 跑测 PASS → commit `feat(evidence): session trace store (jsonl + sentinels + hash chain)` primary runtime-core。

### Task B4: evidence-bridge(吞错封装)

**Files:** Create `lib/evidence/evidence-bridge.js`;Create `tests/evidence-bridge.test.js`

- [ ] **B4-1** 测试先行:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  recordToolCallEvidence, recordRefusedToolCall,
} from "../lib/evidence/evidence-bridge.js";
import {
  sessionTraceFile, clearSessionTraceMemory,
} from "../lib/evidence/session-trace-store.js";

test.afterEach(() => { clearSessionTraceMemory(); });

test("recordToolCallEvidence appends internal/fc ok event with digests", async () => {
  const dir = await mkdtemp(join(tmpdir(), "evidence-bridge-"));
  process.env.OPENCLAW_TRACE_DIR = dir;
  const sessionKey = "agent:worker:c:TC-20";
  try {
    await recordToolCallEvidence({
      sessionKey, agentId: "worker", toolName: "write",
      params: { path: "/tmp/r.md", content: "hi" },
      event: { result: { content: [{ type: "text", text: "ok" }] } },
      contractId: "TC-20",
    });
    const lines = (await readFile(sessionTraceFile(sessionKey), "utf8")).trim().split("\n");
    const record = JSON.parse(lines[lines.length - 1]);
    assert.equal(record.kind, "internal");
    assert.equal(record.channel, "fc");
    assert.equal(record.outcome, "ok");
    assert.equal(record.args.path, "/tmp/r.md");
    assert.match(record.args.hash, /^[0-9a-f]{64}$/);
  } finally {
    delete process.env.OPENCLAW_TRACE_DIR;
    await rm(dir, { recursive: true, force: true });
  }
});

test("recordRefusedToolCall appends refused event with blockReason", async () => {
  const dir = await mkdtemp(join(tmpdir(), "evidence-bridge-"));
  process.env.OPENCLAW_TRACE_DIR = dir;
  const sessionKey = "agent:worker:c:TC-21";
  try {
    await recordRefusedToolCall({
      sessionKey, agentId: "worker", toolName: "write",
      params: { path: "/etc/passwd" },
      blockReason: "安全策略:写入工作面限定为当前任务文件。",
    });
    const lines = (await readFile(sessionTraceFile(sessionKey), "utf8")).trim().split("\n");
    const record = JSON.parse(lines[lines.length - 1]);
    assert.equal(record.outcome, "refused");
    assert.match(record.result.blockReason, /安全策略/);
  } finally {
    delete process.env.OPENCLAW_TRACE_DIR;
    await rm(dir, { recursive: true, force: true });
  }
});

test("bridge never throws even when the store is broken", async () => {
  process.env.OPENCLAW_TRACE_DIR = "/dev/null/nope"; // mkdir will fail
  try {
    await assert.doesNotReject(recordToolCallEvidence({
      sessionKey: "agent:worker:c:TC-22", agentId: "worker",
      toolName: "read", params: {}, event: {},
    }));
  } finally {
    delete process.env.OPENCLAW_TRACE_DIR;
  }
});
```

- [ ] **B4-2** 跑测 FAIL → 新建 `lib/evidence/evidence-bridge.js`:

```js
// evidence-bridge.js — the ONLY seam hooks call into (spec §2/§3).
// Every export swallows its own failures: the evidence plane is strictly
// weaker than the execution plane, so a broken ledger must never block work.

import {
  TRACE_EVENT_KINDS, TRACE_EVENT_CHANNELS, TRACE_EVENT_OUTCOMES, buildTraceEvent,
} from "./trace-event-schema.js";
import { digestToolArgs, digestToolResult } from "./tool-event-digest.js";
import { appendTraceEvent } from "./session-trace-store.js";
import { isToolOutcomeError } from "../delivery/runtime-user-facing-output.js";

export async function recordToolCallEvidence({
  sessionKey, agentId, toolName, params = {}, event = {}, contractId = null, logger = null,
} = {}) {
  try {
    await appendTraceEvent(sessionKey, buildTraceEvent({
      kind: TRACE_EVENT_KINDS.INTERNAL,
      channel: TRACE_EVENT_CHANNELS.FC,
      name: toolName || "unknown",
      argsDigest: digestToolArgs(toolName, params),
      resultDigest: digestToolResult(event),
      outcome: isToolOutcomeError(event) ? TRACE_EVENT_OUTCOMES.ERROR : TRACE_EVENT_OUTCOMES.OK,
      agentId, sessionKey, contractId,
    }));
  } catch (error) {
    logger?.warn?.(`[watchdog] evidence append failed (non-blocking): ${error.message}`);
  }
}

export async function recordRefusedToolCall({
  sessionKey, agentId, toolName, params = {}, blockReason = "", contractId = null, logger = null,
} = {}) {
  try {
    await appendTraceEvent(sessionKey, buildTraceEvent({
      kind: TRACE_EVENT_KINDS.INTERNAL,
      channel: TRACE_EVENT_CHANNELS.FC,
      name: toolName || "unknown",
      argsDigest: digestToolArgs(toolName, params),
      resultDigest: { blockReason: String(blockReason || "").slice(0, 200) },
      outcome: TRACE_EVENT_OUTCOMES.REFUSED,
      agentId, sessionKey, contractId,
    }));
  } catch (error) {
    logger?.warn?.(`[watchdog] refused-event append failed (non-blocking): ${error.message}`);
  }
}
```

- [ ] **B4-3** 跑测 PASS → commit `feat(evidence): non-throwing evidence bridge helpers` primary runtime-core。

### Task B5: 钩子接线(三处)

**Files:** Modify `hooks/after-tool-call.js`;Modify `hooks/before-tool-call.js`;Modify `hooks/before-agent-start.js`;Modify `hooks/agent-end.js`

- [ ] **B5-1** `after-tool-call.js`:recordStep 块之后插入(变量全部已在作用域):

```js
    // ── Evidence bridge: full-fidelity event into the session trace (never blocks) ──
    await recordToolCallEvidence({
      sessionKey, agentId, toolName, params, event,
      contractId: trackingState?.contract?.id ?? null, logger,
    });
```

  顶部 import `{ recordToolCallEvidence } from "../lib/evidence/evidence-bridge.js"`。
- [ ] **B5-2** `before-tool-call.js`:把现有 async 回调整体抽为同文件内 `async function evaluateBeforeToolCall(event, ctx, logger)`(机械搬移,body 不改;唯一闭包变量 logger 改为参数),register 改为包裹层——14+ 个 block 出口一处全覆盖:

```js
export function register(api, logger) {
  api.on("before_tool_call", async (event, ctx) => {
    const decision = await evaluateBeforeToolCall(event, ctx, logger);
    if (decision?.block === true) {
      await recordRefusedToolCall({
        sessionKey: ctx.sessionKey,
        agentId: ctx.agentId ?? "unknown",
        toolName: event.toolName ?? "unknown",
        params: event.params ?? {},
        blockReason: decision.blockReason,
        contractId: getTrackingState(ctx.sessionKey)?.contract?.id ?? null,
        logger,
      });
    }
    return decision;
  });
}
```

- [ ] **B5-3** `before-agent-start.js`:`initTrace(sessionKey, trackingState.contract);` 之后加:

```js
    await openSessionTrace(sessionKey, {
      agentId, contractId: trackingState.contract?.id ?? null,
    }).catch((error) => logger.warn(`[watchdog] trace open failed (non-blocking): ${error.message}`));
```

- [ ] **B5-4** `agent-end.js`:`await runAgentEndLifecycle({...});` 之后加(仅 tracked 会话,与 open 条件对称;resume 会话多 episode 属预期):

```js
    if (trackingState) {
      await closeSessionTrace(sessionKey, { success: event.success === true })
        .catch((error) => logger.warn(`[watchdog] trace close failed (non-blocking): ${error.message}`));
    }
```

- [ ] **B5-5** 回归:`node --test tests/before-tool-call-path-guard.test.js tests/protocol-commit-reconcile.test.js tests/security-block-reason.test.js` PASS(钩子行为不变,只多记账)。
- [ ] **B5-6** block-check `--primary local-execution` → commit `feat(evidence): wire bridge + sentinels into tool/session hooks`。

### Task B6: 全量回归 + live 冒烟

- [ ] **B6-1** `npm test`(后台)全绿(容忍已知 flaky)。
- [ ] **B6-2** `node ~/.openclaw/extensions/watchdog/test-runner.js` health 70/70。
- [ ] **B6-3** 重启网关加载新代码:`launchctl kickstart -k gui/$(id -u)/ai.openclaw.gateway`;跑 `node ~/.openclaw/extensions/watchdog/test-runner.js --preset dispatch`(最小 live 派工链)预期 8/8。
- [ ] **B6-4** 验证账本落盘:`ls ~/.openclaw/control-plane/trace/` 出现 `*.jsonl`;抽一个文件跑 `node -e` 调 validateSessionTraceContent 预期 complete:true(open/事件/close 俱全);确认 write 事件含 hash、无原文。
- [ ] **B6-5** 收口:更新备忘录128(§四状态)+ wiki status.md;git push 仪式(新 tag,用户确认时机)。

---

## 自查记录

- **Spec 覆盖**:§2 事件模型→B1/B2;§3 账本→B3;§5 P2→A1/A2;桥接线→B4/B5;§10 P2+证据面主干=本批全部。未入本批(按 spec 蓝图属后批):工具库 P3、期望字段、考官、合成事件、submit_plan。
- **占位符扫描**:无 TBD/“适当处理”;每个代码步骤都有完整代码。
- **类型一致**:buildTraceEvent 的 argsDigest/resultDigest 参数名与 bridge 调用一致;TRACE_SENTINELS 两处引用一致;listRuntimeHandledIntents 在 A2-1 测试与 A2-5 实现签名一致;closeSessionTrace 的 eventCount=seq+2(close 自身 seq = state.seq+1,总行数=seq+2)与 B3-1 断言(3 行,eventCount 3)一致。
- **风险**:before-tool-call 回调抽函数是纯机械搬移但文件大(376 行)——执行时用整块剪切,不逐行重写;evidence append 在 after 钩子加一次 await(亚毫秒 IO),该钩子现有工作量远大于此。
