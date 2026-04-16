# Black-Box Test Runner 重构

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将测试工具从硬编码 checkpoint 模式重构为通用黑盒观察者——从 bridge 入口发消息，通过 SSE 事件流记录时间线，通过合约快照验证终态，不对 agent 名称或架构做任何断言。

**Architecture:** 测试工具从 `openclaw.json` 读取 bridge agent，通过 hooks API 发消息。订阅 SSE 事件流如实记录所有 `track_start`/`track_progress`/`track_end`/`alert` 事件构建时间线。轮询 `/watchdog/contracts` 等待合约到达终态。报告展示事件时间线 + 终态验证结果。

**Tech Stack:** Node.js ESM, 复用现有 `infra.js` 的 SSEClient / fetchJSON / loadConfig

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `tests/suite-single.js` | **Rewrite core** | 删除全部 checkpoint 断言逻辑，改为黑盒观察模式 |
| `tests/infra.js` | **Simplify** | 删除 `CHECKPOINTS` 数组，新增 `resolveBridgeAgent()` 和 `sendViaBridge()` |
| `tests/formal-report.js` | **Rewrite** | 新的时间线报告格式 |
| `lib/formal-test-presets.js` | **Minor** | 更新描述文本 |
| `test-runner.js` | **Minor** | 入口不变，只调整调用签名 |

不创建新文件，全部在现有文件上改。

---

### Task 1: 简化 infra.js — 删除 CHECKPOINTS，新增 bridge 入口

**Files:**
- Modify: `tests/infra.js`

- [ ] **Step 1: 删除 CHECKPOINTS 数组**

删除 `infra.js` 中的 `CHECKPOINTS` export（约 L80-94）。现在不需要预定义的 checkpoint 列表了。同时从 export 列表中移除 `CHECKPOINTS`。

- [ ] **Step 2: 新增 `resolveBridgeAgent()` 函数**

在 `infra.js` 中新增，从已加载的 config 里找到第一个 bridge 角色的 agent：

```javascript
/**
 * 从 openclaw.json 中找到第一个 bridge 类型的 agent（优先 QQ 绑定）。
 * 不硬编码 agent 名称——结构变了也能自动适配。
 */
export function resolveBridgeAgent() {
  const agents = cfg?.agents?.list || [];
  // 优先找有 channel binding 的 bridge
  const withBinding = agents.find(a =>
    a.binding?.roleRef === "bridge" && cfg?.channelBindings?.some(b => b.agentId === a.id)
  );
  if (withBinding) return withBinding.id;
  // fallback: 任意 bridge
  const anyBridge = agents.find(a => a.binding?.roleRef === "bridge");
  return anyBridge?.id || null;
}
```

其中 `cfg` 是 `infra.js` 已有的模块级变量（`loadConfig()` 填充）。

- [ ] **Step 3: 新增 `sendViaBridge(message)` 函数**

```javascript
/**
 * 通过 bridge agent 发送消息，模拟真实用户入口。
 */
export async function sendViaBridge(message) {
  const bridgeId = resolveBridgeAgent();
  if (!bridgeId) throw new Error("No bridge agent found in openclaw.json");
  return wakeAgentNow(bridgeId, message);
}
```

`wakeAgentNow` 已经存在于 `infra.js`，调用 `POST /hooks/agent` + `agentId` + `wakeMode: "now"`。

- [ ] **Step 4: 确认 exports**

确保 `resolveBridgeAgent` 和 `sendViaBridge` 被 export。`CHECKPOINTS` 不再 export。

- [ ] **Step 5: Commit**

```bash
git add tests/infra.js
git commit -m "refactor(test): remove hardcoded CHECKPOINTS, add bridge-based entry"
```

---

### Task 2: 重写 suite-single.js — 黑盒观察模式

**Files:**
- Modify: `tests/suite-single.js`

- [ ] **Step 1: 精简测试用例定义**

把 `SINGLE_CASES` 改为纯黑盒定义，删除所有架构耦合字段：

```javascript
export const SINGLE_CASES = [
  { id: "simple-01", message: "今天星期几",         timeoutMs: 120000, validate: { minBytes: 10 } },
  { id: "simple-02", message: "现在几点了",         timeoutMs: 120000, validate: { minBytes: 10 } },
  { id: "simple-03", message: "你好",               timeoutMs: 120000, validate: { minBytes: 10 } },
  { id: "complex-01", message: "研究北京最近三天天气并总结趋势", timeoutMs: 180000, validate: { minBytes: 100, keywords: ["天气", "趋势"] } },
  { id: "complex-02", message: "对比 React、Vue、Svelte 三个框架的优缺点，写一份报告", timeoutMs: 180000, validate: { minBytes: 100, keywords: ["React", "Vue"] } },
  { id: "complex-03", message: "分析 OpenClaw 的设计原则，总结核心要点", timeoutMs: 180000, validate: { minBytes: 100 } },
];
```

删除 `expectedPath`、`scenario`、`businessSemantics`、`transportPath`、`expectedRuntimeTruth`、`coverage` 等所有架构字段。也删除 QQ 专用 case（`qq-simple-01`、`qq-complex-01`），因为统一从 bridge 入口发送。

`CONCURRENT_CASES` 保持结构不变，只更新引用的 case ID 和描述。

- [ ] **Step 2: 精简 ISSUE_CATALOG**

只保留通用的、不引用具体 agent 名的错误码：

```javascript
const ISSUE_CATALOG = {
  E_SEND_FAIL:          { subsystem: "bridge-entry",     conclusion: "消息发送失败",            suggestedFix: "检查 bridge agent 配置和 gateway 状态。" },
  E_CONTRACT_MISSING:   { subsystem: "ingress",          conclusion: "消息已发送但合约未创建",    suggestedFix: "检查 ingress 分流和合约创建逻辑。" },
  E_TIMEOUT:            { subsystem: "end-to-end",       conclusion: "合约未在超时内到达终态",    suggestedFix: "检查事件时间线，定位阻塞阶段。" },
  E_CONTRACT_FAILED:    { subsystem: "execution",        conclusion: "合约执行后状态为 failed",   suggestedFix: "检查最后活跃的 agent session 和错误日志。" },
  E_OUTPUT_MISSING:     { subsystem: "output",           conclusion: "合约完成但输出文件不存在",   suggestedFix: "检查 output 目录写入和 artifact 提交。" },
  E_OUTPUT_TOO_SMALL:   { subsystem: "output-quality",   conclusion: "输出文件内容过短",         suggestedFix: "检查 worker 产出和最小字数要求。" },
  E_OUTPUT_KEYWORD_MISS:{ subsystem: "output-quality",   conclusion: "输出文件缺少关键内容",     suggestedFix: "检查提示约束和验证关键字。" },
};
```

- [ ] **Step 3: 重写 `runSingleTest` 函数核心逻辑**

新逻辑分三步：**发送 → 观察 → 验证**。

```javascript
export async function runSingleTest(testCase, sse, _logOffset, queuePosition, options = {}) {
  const startMs = Date.now();
  const elapsed = () => ((Date.now() - startMs) / 1000).toFixed(1);
  const timeline = [];    // 事件时间线
  let contractId = null;
  let finalStatus = null;

  // ── Phase 1: 发送 ──
  try {
    await sendViaBridge(testCase.message);
  } catch (e) {
    return buildResult(testCase, { verdict: "FAIL", errorCode: "E_SEND_FAIL", detail: e.message, timeline, elapsed: elapsed() });
  }

  // ── Phase 2: 观察 SSE 事件流 + 轮询合约终态 ──
  const deadline = Date.now() + testCase.timeoutMs;

  // 2a: 等待合约创建（从 SSE inbox_dispatch 事件获取 contractId）
  const draftEvt = await sse.waitFor(
    e => e.type === "alert" && e.data?.type === "inbox_dispatch" && e.receivedAt >= startMs,
    Math.min(30000, testCase.timeoutMs)
  );
  if (draftEvt) {
    contractId = draftEvt.data?.contractId;
    timeline.push({ ts: elapsed(), event: "contract created", detail: contractId });
  }
  if (!contractId) {
    // fallback: 轮询 contracts API
    contractId = await pollForContract(testCase.message, startMs, 15000);
  }
  if (!contractId) {
    return buildResult(testCase, { verdict: "FAIL", errorCode: "E_CONTRACT_MISSING", timeline, elapsed: elapsed() });
  }

  // 2b: 持续收集 SSE 事件 + 轮询合约状态，直到终态或超时
  const terminalStatuses = new Set(["completed", "failed", "abandoned"]);
  while (Date.now() < deadline) {
    // 收集所有新的 SSE 事件到时间线
    drainSSEEvents(sse, startMs, contractId, timeline);

    // 轮询合约状态
    try {
      const contracts = await fetchJSON("/watchdog/contracts");
      const c = contracts.find(c => c.id === contractId);
      if (c && terminalStatuses.has(c.status)) {
        finalStatus = c.status;
        timeline.push({ ts: elapsed(), event: "contract " + finalStatus });
        break;
      }
    } catch {}
    await sleep(1000);
  }

  // 最后一次 drain
  drainSSEEvents(sse, startMs, contractId, timeline);

  if (!finalStatus) {
    return buildResult(testCase, { verdict: "FAIL", errorCode: "E_TIMEOUT", timeline, elapsed: elapsed(), contractId });
  }
  if (finalStatus === "failed") {
    return buildResult(testCase, { verdict: "FAIL", errorCode: "E_CONTRACT_FAILED", timeline, elapsed: elapsed(), contractId });
  }

  // ── Phase 3: 验证输出 ──
  const outputValidation = await validateOutput(contractId, testCase.validate);
  if (outputValidation.error) {
    timeline.push({ ts: elapsed(), event: "output validation failed", detail: outputValidation.error });
    return buildResult(testCase, { verdict: "FAIL", errorCode: outputValidation.errorCode, timeline, elapsed: elapsed(), contractId, outputInfo: outputValidation });
  }
  timeline.push({ ts: elapsed(), event: "output validated", detail: `${outputValidation.bytes} bytes` });

  return buildResult(testCase, { verdict: "PASS", timeline, elapsed: elapsed(), contractId, outputInfo: outputValidation });
}
```

- [ ] **Step 4: 实现辅助函数**

`drainSSEEvents` — 从 SSE 客户端拉取尚未 claim 的事件，转换为时间线条目：

```javascript
function drainSSEEvents(sse, startMs, contractId, timeline) {
  for (const evt of sse.events) {
    if (evt.claimed || evt.replay) continue;
    if (evt.receivedAt < startMs) continue;
    // 只记录和当前合约相关的事件（或无 contractId 的通用事件）
    const evtCid = evt.data?.contractId;
    if (evtCid && evtCid !== contractId) continue;

    evt.claimed = true;
    const ts = ((evt.receivedAt - startMs) / 1000).toFixed(1);
    const agentId = evt.data?.agentId || null;

    if (evt.type === "track_start") {
      timeline.push({ ts, event: "agent session start", detail: agentId });
    } else if (evt.type === "track_end") {
      timeline.push({ ts, event: "agent session end", detail: agentId });
    } else if (evt.type === "track_progress") {
      const tools = evt.data?.toolCallCount || 0;
      timeline.push({ ts, event: "agent tool call", detail: `${agentId} tools=${tools}` });
    } else if (evt.type === "alert" && evt.data?.type === "delivery_created") {
      timeline.push({ ts, event: "delivery created", detail: evt.data?.deliveryId || null });
    } else if (evt.type === "alert" && evt.data?.type === "delivery_notified") {
      timeline.push({ ts, event: "delivery notified", detail: evt.data?.targetAgent || null });
    }
  }
}
```

`pollForContract` — 备用：从 contracts API 查找匹配 task 文本的合约：

```javascript
async function pollForContract(taskText, afterMs, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const contracts = await fetchJSON("/watchdog/contracts");
      const c = contracts.find(c => c.task === taskText && c.createdAt >= afterMs);
      if (c) return c.id;
    } catch {}
    await sleep(500);
  }
  return null;
}
```

`validateOutput` — 检查 output 文件：

```javascript
async function validateOutput(contractId, validate) {
  if (!validate) return { ok: true, bytes: 0 };
  const outputPath = join(OUTPUT_DIR, `${contractId}.md`);
  let content;
  try {
    content = await readFile(outputPath, "utf8");
  } catch {
    return { ok: false, error: "output file not found", errorCode: "E_OUTPUT_MISSING", bytes: 0 };
  }
  const bytes = Buffer.byteLength(content, "utf8");
  if (validate.minBytes && bytes < validate.minBytes) {
    return { ok: false, error: `${bytes} bytes < ${validate.minBytes} min`, errorCode: "E_OUTPUT_TOO_SMALL", bytes };
  }
  if (validate.keywords) {
    const missing = validate.keywords.filter(kw => !content.includes(kw));
    if (missing.length > 0) {
      return { ok: false, error: `missing keywords: ${missing.join(", ")}`, errorCode: "E_OUTPUT_KEYWORD_MISS", bytes };
    }
  }
  return { ok: true, bytes };
}
```

`buildResult` — 组装结果对象：

```javascript
function buildResult(testCase, { verdict, errorCode, detail, timeline, elapsed, contractId, outputInfo }) {
  return {
    testCase,
    pass: verdict === "PASS",
    blocked: false,
    duration: elapsed,
    contractId: contractId || null,
    timeline: timeline || [],
    errorCode: errorCode || null,
    errorDetail: detail || null,
    outputInfo: outputInfo || null,
  };
}
```

- [ ] **Step 5: 删除旧代码**

删除以下不再需要的内容：
- `CHECKPOINTS` import（已从 infra.js 删除）
- `classifyFullPathExecutionMode` / `getFormalFullPathCasePolicy` import
- 旧的 `runSingleTest` 函数（全部 checkpoint 逻辑）
- `waitForLoopEntryStart` 及相关辅助函数
- `fetchContractRuntimeSnapshot` 函数
- `isFastTrack` 相关的所有逻辑

- [ ] **Step 6: Commit**

```bash
git add tests/suite-single.js
git commit -m "refactor(test): rewrite suite-single as black-box observer"
```

---

### Task 3: 重写 formal-report.js — 时间线报告格式

**Files:**
- Modify: `tests/formal-report.js`

- [ ] **Step 1: 重写 `generateFormalReport`**

新报告格式匹配用户确认的样式：

```javascript
export function generateFormalReport({ suiteType, totalDuration, gatewayPort, testResults }) {
  const lines = [];
  const now = new Date().toISOString().replace("T", " ").slice(0, 19);
  const passed = testResults.filter(r => r.pass).length;
  const failed = testResults.filter(r => !r.pass).length;

  lines.push("══════════════════════════════════════════════════");
  lines.push(" OPENCLAW TEST REPORT");
  lines.push(` Run: ${now}  Duration: ${totalDuration}s`);
  lines.push(` Gateway: localhost:${gatewayPort}`);
  lines.push(` Suite: ${suiteType} | Cases: ${testResults.length}`);
  lines.push("══════════════════════════════════════════════════");
  lines.push("");

  for (const tr of testResults) {
    const tc = tr.testCase;
    const verdict = tr.pass ? "PASS" : "FAIL";
    lines.push(`── TEST: "${tc.message.slice(0, 50)}"  ${verdict}  ${tr.duration}s ──`);

    if (tr.contractId) {
      lines.push(`  Contract: ${tr.contractId}`);
    }
    lines.push("");

    // 事件时间线
    if (tr.timeline && tr.timeline.length > 0) {
      lines.push("  EVENT TIMELINE:");
      for (const entry of tr.timeline) {
        const tsStr = `${entry.ts}s`.padStart(7);
        const evtStr = entry.event.padEnd(24);
        const detail = entry.detail ? `  ${entry.detail}` : "";
        lines.push(`    ${tsStr}  ${evtStr}${detail}`);
      }
      lines.push("");
    }

    // 结果
    lines.push("  RESULT:");
    if (tr.pass) {
      lines.push(`    status: completed`);
      if (tr.outputInfo?.bytes) {
        const minLabel = tc.validate?.minBytes ? ` (min ${tc.validate.minBytes})` : "";
        lines.push(`    output: ${tr.outputInfo.bytes} bytes ✓${minLabel}`);
      }
    } else {
      lines.push(`    status: ${tr.errorCode || "FAIL"}`);
      if (tr.errorDetail) lines.push(`    detail: ${tr.errorDetail}`);
      const issue = ISSUE_CATALOG[tr.errorCode];
      if (issue) {
        lines.push(`    diagnosis: [${issue.subsystem}] ${issue.conclusion}`);
        lines.push(`    fix: ${issue.suggestedFix}`);
      }
    }
    lines.push("");
  }

  lines.push("══════════════════════════════════════════════════");
  lines.push(` SUMMARY: ${passed}/${testResults.length} PASSED  ${failed} FAILED`);

  if (passed > 0) {
    const avg = (testResults.filter(r => r.pass).reduce((s, r) => s + parseFloat(r.duration), 0) / passed).toFixed(1);
    lines.push(` avg: ${avg}s`);
  }
  lines.push("══════════════════════════════════════════════════");

  return lines.join("\n");
}
```

注意 `ISSUE_CATALOG` 需要从 `suite-single.js` import 或直接内联。选择 import。

- [ ] **Step 2: 删除旧的 checkpoint 格式代码**

删除 `normalizeRuntimeTruth`、`normalizeDiagnosis` 等和旧 checkpoint 结构耦合的函数。

- [ ] **Step 3: Commit**

```bash
git add tests/formal-report.js
git commit -m "refactor(test): timeline-based report format"
```

---

### Task 4: 适配 test-runner.js 和 generateReport

**Files:**
- Modify: `test-runner.js`
- Modify: `tests/suite-single.js` (generateReport 函数)

- [ ] **Step 1: 更新 suite-single.js 的 `generateReport`**

```javascript
export function generateReport(testResults, suiteType, totalDuration) {
  return generateFormalReport({
    suiteType,
    totalDuration,
    gatewayPort: PORT,
    testResults,
  });
}
```

删除旧的 legacy report 分支和 `summarizeTestDiagnosis` 等旧函数。

- [ ] **Step 2: 更新 test-runner.js 的 import**

从 `tests/infra.js` 的 import 中移除 `CHECKPOINTS`（已删除）。确认 `sendViaBridge` 不需要在 `test-runner.js` 中 import（它在 `suite-single.js` 内部使用）。

- [ ] **Step 3: 更新 formal-test-presets.js 描述**

已在之前的编辑中完成，确认描述不包含 "fast-track" 或 "full-path"。

- [ ] **Step 4: 运行测试验证**

```bash
rm -rf /var/folders/n3/mp3gzlss3rn5gc0qqw1jffm40000gn/T/openclaw-test-locks/global-test-environment
node test-runner.js --preset single
```

预期输出：
```
── TEST: "你好"  PASS  ~30s ──
  Contract: TC-xxx

  EVENT TIMELINE:
    0.1s  contract created          TC-xxx
    0.2s  agent session start       planner
   17.4s  agent session end         planner
   17.5s  agent session start       worker
   19.0s  agent tool call           worker tools=1
   26.6s  agent session end         worker
   26.6s  delivery created          DL-TC-xxx
   26.6s  contract completed

  RESULT:
    status: completed
    output: 240 bytes ✓ (min 10)

══════════════════════════════════════════════════
 SUMMARY: 1/1 PASSED  0 FAILED
══════════════════════════════════════════════════
```

- [ ] **Step 5: 运行 multi 测试**

```bash
rm -rf /var/folders/n3/mp3gzlss3rn5gc0qqw1jffm40000gn/T/openclaw-test-locks/global-test-environment
node test-runner.js --preset multi
```

预期：3/3 PASSED

- [ ] **Step 6: Commit**

```bash
git add test-runner.js tests/suite-single.js tests/formal-report.js lib/formal-test-presets.js
git commit -m "refactor(test): complete black-box test runner migration"
```
