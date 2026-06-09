# Harness Module Contract Freeze Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `HarnessModule` 的第一版正式接口从散落实现里提炼出来，用代码和测试冻结 `definition / kind / start input / finalize input` 这几个最小合同。

**Architecture:** 新增一个窄文件 `harness-module-contract.js`，只承载 `HarnessModule` 的最小合同与归一化函数，不接管 `HarnessRun` 或 evaluator 逻辑。现有 `harness-registry / harness-run / harness-module-evaluators` 改为消费这份合同，避免 kind 归一化和 start/finalize 输入结构继续散落。

**Tech Stack:** Node.js ESM, watchdog harness libs, built-in `node:test`.

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `extensions/watchdog/lib/harness/harness-module-contract.js` | Create | 冻结 `HarnessModuleDefinition`、kind、start/finalize input 的最小合同 |
| `extensions/watchdog/lib/harness/harness-registry.js` | Modify | 让 registry 输出 canonical module definitions |
| `extensions/watchdog/lib/harness/harness-run.js` | Modify | 复用 canonical kind normalizer，不再本地散落 |
| `extensions/watchdog/lib/harness/harness-module-evaluators.js` | Modify | 在 start/finalize phase 使用统一 input builder |
| `extensions/watchdog/tests/harness-module-contract.test.js` | Create | 锁死 module contract 的最小行为 |
| `extensions/watchdog/tests/review-harness-modules.test.js` | Modify | 锁死 registry 返回的 module kinds 只落在四类 active kinds |

---

### Task 1: Write the Failing Contract Tests

**Files:**
- Create: `extensions/watchdog/tests/harness-module-contract.test.js`
- Modify: `extensions/watchdog/tests/review-harness-modules.test.js`

- [ ] **Step 1: Add contract tests for canonical kinds and interface builders**

```javascript
import test from "node:test";
import assert from "node:assert/strict";

import {
  HARNESS_MODULE_KIND,
  normalizeHarnessModuleDefinition,
  buildHarnessModuleStartInput,
  buildHarnessModuleFinalizeInput,
} from "../lib/harness/harness-module-contract.js";

test("normalizeHarnessModuleDefinition canonicalizes legacy adapter kinds to normalizer", () => {
  const definition = normalizeHarnessModuleDefinition({
    id: "harness:normalizer.failure",
    kind: "adapter",
    hardShaped: ["failure_classification"],
  });

  assert.equal(definition.kind, HARNESS_MODULE_KIND.NORMALIZER);
});

test("buildHarnessModuleStartInput produces the canonical start-phase shape", () => {
  const input = buildHarnessModuleStartInput({
    moduleId: "harness:guard.budget",
    harnessRun: { automationId: "auto-1", round: 1, requestedAt: 1, status: "running" },
    automationSpec: { id: "auto-1", harness: { moduleConfig: { "harness:guard.budget": { budgetSeconds: 30 } } } },
    executionContext: { targetAgent: "worker", tools: ["read"] },
  });

  assert.equal(input.phase, "start");
  assert.equal(input.module.kind, "guard");
  assert.equal(input.moduleConfig.budgetSeconds, 30);
  assert.equal("terminalSource" in input, false);
  assert.equal("baseEvidence" in input, false);
});

test("buildHarnessModuleFinalizeInput carries terminal evidence but preserves the same module contract", () => {
  const input = buildHarnessModuleFinalizeInput({
    moduleId: "harness:gate.artifact",
    harnessRun: { automationId: "auto-1", round: 1, requestedAt: 1, status: "completed" },
    automationSpec: { id: "auto-1" },
    executionContext: { targetAgent: "worker" },
    terminalSource: { terminalOutcome: { artifact: "/tmp/out.md" } },
    baseEvidence: { artifact: { present: true, path: "/tmp/out.md" } },
  });

  assert.equal(input.phase, "finalize");
  assert.equal(input.module.kind, "gate");
  assert.equal(input.baseEvidence.artifact.path, "/tmp/out.md");
});
```

- [ ] **Step 2: Tighten registry test to reject non-active runtime kinds**

```javascript
test("review harness modules stay within the four active runtime kinds", () => {
  const modules = [
    getHarnessModule("harness:gate.schema"),
    getHarnessModule("harness:normalizer.failure"),
    getHarnessModule("harness:gate.artifact"),
  ];
  const activeKinds = new Set(["guard", "collector", "gate", "normalizer"]);
  assert.equal(modules.every((module) => activeKinds.has(module.kind)), true);
});
```

- [ ] **Step 3: Run tests to verify RED**

Run:

```bash
cd /Users/hakens/.openclaw/extensions/watchdog
node --test tests/harness-module-contract.test.js tests/review-harness-modules.test.js
```

Expected:
- FAIL because `harness-module-contract.js` does not exist yet

---

### Task 2: Implement the Minimal Contract Module

**Files:**
- Create: `extensions/watchdog/lib/harness/harness-module-contract.js`
- Modify: `extensions/watchdog/lib/harness/harness-registry.js`
- Modify: `extensions/watchdog/lib/harness/harness-run.js`
- Modify: `extensions/watchdog/lib/harness/harness-module-evaluators.js`

- [ ] **Step 1: Add the canonical module contract**

```javascript
export const HARNESS_MODULE_KIND = Object.freeze({
  GUARD: "guard",
  COLLECTOR: "collector",
  GATE: "gate",
  NORMALIZER: "normalizer",
});
```

- [ ] **Step 2: Centralize kind/definition normalization**

```javascript
export function normalizeHarnessModuleDefinition(value) {
  // id + canonical kind + hardShaped only
}
```

- [ ] **Step 3: Add start/finalize input builders**

```javascript
export function buildHarnessModuleStartInput(args) {
  return { phase: "start", ... };
}

export function buildHarnessModuleFinalizeInput(args) {
  return { phase: "finalize", ... };
}
```

- [ ] **Step 4: Repoint registry/run/evaluators to the shared contract**

```javascript
import {
  normalizeHarnessModuleDefinition,
  normalizeHarnessModuleKind,
  buildHarnessModuleStartInput,
  buildHarnessModuleFinalizeInput,
} from "./harness-module-contract.js";
```

- [ ] **Step 5: Run targeted tests to verify GREEN**

Run:

```bash
cd /Users/hakens/.openclaw/extensions/watchdog
node --test tests/harness-module-contract.test.js tests/review-harness-modules.test.js
```

Expected:
- PASS

---

### Task 3: Run Broader Harness Regression Slice

**Files:**
- Verify only

- [ ] **Step 1: Run the broader harness tests**

Run:

```bash
cd /Users/hakens/.openclaw/extensions/watchdog
node --test tests/harness-module-contract.test.js tests/review-harness-modules.test.js tests/harness-run-store.test.js tests/harness-run-dedup.test.js tests/automation-harness-projection.test.js tests/terminal-truth-consumers.test.js
```

Expected:
- PASS
