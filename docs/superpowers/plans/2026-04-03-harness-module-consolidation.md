# Harness Module Consolidation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge 22 harness modules into 10, rename to `harness:` namespace, delete empty shells, make `executionMode` a derived value instead of a preset config.

**Architecture:** Module IDs change from flat names (`timeout_guard`) to namespaced (`harness:guard.budget`). Evaluator logic for merged modules consolidates into single switch cases. Profiles update their `moduleRefs` to new IDs. `executionMode` becomes computed from coverage ratio. All 17 consumer files updated via ID mapping.

**Tech Stack:** Node.js (ES modules), no new dependencies.

---

## ID Mapping (old → new)

```
# Guards (7 → 3)
timeout_guard            → harness:guard.budget
cancellation_guard       → harness:guard.budget      (merged)
retry_budget_guard       → harness:guard.budget      (merged)
tool_whitelist_guard     → harness:guard.tool_access
network_policy_guard     → harness:guard.tool_access  (merged)
sandbox_policy_guard     → harness:guard.scope
workspace_scope_guard    → harness:guard.scope        (merged)

# Collectors (4 → 2)
artifact_collector       → harness:collector.artifact
diff_collector           → harness:collector.artifact  (merged)
trace_capture            → harness:collector.trace
log_collector            → harness:collector.trace     (merged)

# Gates (9 → 3)
artifact_required_check          → harness:gate.artifact
stage_artifact_set_check         → harness:gate.artifact   (merged)
experiment_status_connected_check → harness:gate.artifact   (merged)
review_artifact_required_check   → harness:gate.artifact   (merged)
schema_valid_check               → harness:gate.schema
stage_schema_check               → harness:gate.schema     (merged)
review_finding_schema_check      → harness:gate.schema     (merged)
test_pass_required_check         → harness:gate.test
code_quality_gate                → DELETED (no evaluator logic)

# Normalizers (4 → 2)
evaluation_input_builder       → harness:normalizer.eval_input
stage_evaluation_input_builder → harness:normalizer.eval_input  (merged)
run_failure_classifier         → harness:normalizer.failure
review_verdict_normalizer      → DELETED (no evaluator logic)
```

## Files to modify

| File | Change |
|------|--------|
| `lib/harness-registry.js` | Rewrite HARNESS_MODULES (22→10), update HARNESS_PROFILES moduleRefs, make executionMode derived, remove assuranceLevel |
| `lib/harness-module-evaluators.js` | Consolidate evaluator functions per merged module, update GUARD_REGISTRY keys, update switch cases |
| `lib/harness-module-evidence.js` | Update `getModuleDefinition` calls if needed, update `resolveHarnessModuleConfig` |
| `lib/harness-module-runner.js` | Update `listModuleIds` references |
| `lib/harness-run.js` | Remove VALID_EXECUTION_MODES if moved to registry |
| `lib/harness-dashboard.js` | Update module ID references in dashboard summary |
| `lib/automation-harness-projection.js` | Update module ID references |
| `lib/pipeline-harness.js` | Update moduleRefs to new IDs |
| `lib/automation-admin.js` | Update module config parsing |
| `lib/automation-registry.js` | Update normalizeHarnessSelection references |
| `dashboard-harness-shared.js` | Update UI module display |
| `dashboard-harness-atlas.js` | Update atlas view module IDs |
| `dashboard-harness-placement.js` | Update placement view |
| `dashboard-devtools-management.js` | Update devtools references |
| `tests/review-harness-modules.test.js` | Update test module IDs |
| `tests/harness-run-store.test.js` | Update test data |
| `tests/automation-harness-projection.test.js` | Update test data |

---

### Task 1: Rewrite HARNESS_MODULES registry

**Files:**
- Modify: `extensions/watchdog/lib/harness-registry.js:38-159`

- [ ] **Step 1: Replace HARNESS_MODULES with consolidated 10 modules**

```js
export const HARNESS_MODULES = freezeRecords([
  // ── Guards ──
  {
    id: "harness:guard.budget",
    kind: "guard",
    hardShaped: ["timeout_budget", "cancellation_boundary", "retry_budget"],
  },
  {
    id: "harness:guard.tool_access",
    kind: "guard",
    hardShaped: ["tool_surface_whitelist", "network_boundary"],
  },
  {
    id: "harness:guard.scope",
    kind: "guard",
    hardShaped: ["sandbox_boundary", "workspace_scope"],
  },
  // ── Collectors ──
  {
    id: "harness:collector.artifact",
    kind: "collector",
    hardShaped: ["artifact_capture", "diff_capture"],
  },
  {
    id: "harness:collector.trace",
    kind: "collector",
    hardShaped: ["trace_capture", "log_capture"],
  },
  // ── Gates ──
  {
    id: "harness:gate.artifact",
    kind: "gate",
    hardShaped: ["required_artifact_gate", "stage_artifact_set_gate", "experiment_status_gate", "review_artifact_gate"],
  },
  {
    id: "harness:gate.schema",
    kind: "gate",
    hardShaped: ["schema_gate", "stage_schema_gate", "review_finding_schema"],
  },
  {
    id: "harness:gate.test",
    kind: "gate",
    hardShaped: ["test_gate"],
  },
  // ── Normalizers ──
  {
    id: "harness:normalizer.eval_input",
    kind: "normalizer",
    hardShaped: ["evaluation_input_normalization", "stage_evaluation_input"],
  },
  {
    id: "harness:normalizer.failure",
    kind: "normalizer",
    hardShaped: ["failure_classification", "review_verdict_normalization"],
  },
]);
```

- [ ] **Step 2: Add backward-compat ID mapping for migration**

```js
// Temporary migration map — consumers that store old IDs in persisted data
// (harness-run records, automation specs) can resolve via this map.
export const LEGACY_MODULE_ID_MAP = Object.freeze({
  timeout_guard: "harness:guard.budget",
  cancellation_guard: "harness:guard.budget",
  retry_budget_guard: "harness:guard.budget",
  tool_whitelist_guard: "harness:guard.tool_access",
  network_policy_guard: "harness:guard.tool_access",
  sandbox_policy_guard: "harness:guard.scope",
  workspace_scope_guard: "harness:guard.scope",
  artifact_collector: "harness:collector.artifact",
  diff_collector: "harness:collector.artifact",
  trace_capture: "harness:collector.trace",
  log_collector: "harness:collector.trace",
  artifact_required_check: "harness:gate.artifact",
  stage_artifact_set_check: "harness:gate.artifact",
  experiment_status_connected_check: "harness:gate.artifact",
  review_artifact_required_check: "harness:gate.artifact",
  schema_valid_check: "harness:gate.schema",
  stage_schema_check: "harness:gate.schema",
  review_finding_schema_check: "harness:gate.schema",
  test_pass_required_check: "harness:gate.test",
  evaluation_input_builder: "harness:normalizer.eval_input",
  stage_evaluation_input_builder: "harness:normalizer.eval_input",
  run_failure_classifier: "harness:normalizer.failure",
  review_verdict_normalizer: "harness:normalizer.failure",
  code_quality_gate: null,  // deleted
});

export function resolveModuleId(id) {
  if (!id) return null;
  return LEGACY_MODULE_ID_MAP[id] ?? (getHarnessModule(id) ? id : null);
}
```

- [ ] **Step 3: Update `getHarnessModule` to also check legacy map**

```js
export function getHarnessModule(moduleId) {
  const normalizedId = normalizeString(moduleId);
  if (!normalizedId) return null;
  const resolvedId = LEGACY_MODULE_ID_MAP[normalizedId] ?? normalizedId;
  if (resolvedId === null) return null; // deleted module
  return HARNESS_MODULES.find((entry) => entry.id === resolvedId) || null;
}
```

- [ ] **Step 4: Verify module loads**

Run: `node -e "import('/Users/hakens/.openclaw/extensions/watchdog/lib/harness-registry.js').then(m => { console.log('modules:', m.listHarnessModules().length); console.log('legacy map:', Object.keys(m.LEGACY_MODULE_ID_MAP).length) })"`
Expected: `modules: 10`, `legacy map: 23`

---

### Task 2: Update HARNESS_PROFILES to use new module IDs

**Files:**
- Modify: `extensions/watchdog/lib/harness-registry.js:161-255`

- [ ] **Step 1: Rewrite profiles with new IDs (deduplicated)**

```js
export const HARNESS_PROFILES = freezeRecords([
  {
    id: "coding.patch_and_test",
    trustLevel: "stable",
    moduleRefs: [
      "harness:guard.tool_access",
      "harness:guard.scope",
      "harness:collector.trace",
      "harness:collector.artifact",
      "harness:gate.test",
      "harness:gate.artifact",
      "harness:normalizer.eval_input",
    ],
    softGuided: ["change_summary", "handoff_note"],
    freeform: ["implementation_strategy", "refactor_style"],
  },
  {
    id: "experiment.research_cycle",
    trustLevel: "provisional",
    moduleRefs: [
      "harness:guard.budget",
      "harness:collector.trace",
      "harness:collector.artifact",
      "harness:gate.artifact",
      "harness:gate.schema",
      "harness:normalizer.eval_input",
      "harness:normalizer.failure",
    ],
    softGuided: ["experiment_memo", "error_list", "structured_handoff"],
    freeform: ["research_reasoning", "parameter_search_direction", "implementation_strategy"],
  },
  {
    id: "evaluation.score_and_verdict",
    trustLevel: "stable",
    moduleRefs: [
      "harness:collector.artifact",
      "harness:gate.schema",
      "harness:gate.artifact",
      "harness:normalizer.eval_input",
      "harness:normalizer.failure",
    ],
    softGuided: ["score_explanation", "verdict_summary"],
    freeform: ["qualitative_reasoning"],
  },
  {
    id: "stage.completion",
    trustLevel: "experimental",
    moduleRefs: [
      "harness:gate.artifact",
      "harness:gate.schema",
      "harness:normalizer.eval_input",
    ],
    softGuided: ["stage_summary", "stage_handoff"],
    freeform: ["stage_reasoning", "stage_trace"],
  },
]);
```

- [ ] **Step 2: Remove `defaultMode` and `defaultAssuranceLevel` from profiles**

These were preset configs. Mode should be derived from coverage, not pre-assigned. Remove the fields from freezeRecords and all profile definitions. Update `normalizeHarnessSelection` to derive mode:

```js
// Replace lines 483-488 (mode selection) with:
const totalCoverage = coverage.hardShaped.length + coverage.softGuided.length + coverage.freeform.length;
const hardRatio = totalCoverage > 0 ? coverage.hardShaped.length / totalCoverage : 0;
let mode;
if (hardRatio === 0 && modules.length === 0) mode = "freeform";
else if (hardRatio >= 0.8) mode = "guarded";
else mode = "hybrid";
```

- [ ] **Step 3: Remove `assuranceLevel` — it duplicates mode semantics**

Delete `normalizeAssuranceLevel`, `VALID_ASSURANCE_LEVELS`, `deriveDefaultAssuranceLevel`. Remove `assuranceLevel` from `normalizeHarnessSelection` return. Remove from all consumers (harness-run.js, automation-harness-projection.js, etc.).

- [ ] **Step 4: Verify profiles load correctly**

Run: `node -e "import('/Users/hakens/.openclaw/extensions/watchdog/lib/harness-registry.js').then(m => m.listHarnessProfiles().forEach(p => console.log(p.id, p.moduleRefs.length, 'modules')))"`
Expected: 4 profiles, each with correct module count.

---

### Task 3: Consolidate evaluator logic

**Files:**
- Modify: `extensions/watchdog/lib/harness-module-evaluators.js`

- [ ] **Step 1: Merge guard evaluators into new IDs**

Update `GUARD_REGISTRY` keys:
```js
const GUARD_REGISTRY = {
  "harness:guard.tool_access": { evaluate: evaluateToolAccessGuard },   // combines tool_whitelist + network_policy
  "harness:guard.scope": { evaluate: evaluateScopeGuard },              // combines sandbox_policy + workspace_scope
  "harness:guard.budget": {                                              // combines timeout + retry + cancellation
    start: evaluateBudgetStart,
    final: evaluateBudgetFinal,
  },
  "harness:collector.trace": {
    start: evaluateTraceStart,
    final: evaluateTraceFinal,
  },
};
```

- [ ] **Step 2: Write merged evaluator functions**

`evaluateToolAccessGuard(ctx)`: run `evaluateToolWhitelist(ctx)` first; if passed, also check `evaluateNetworkPolicy(ctx)`; combine evidence; worst status wins.

`evaluateScopeGuard(ctx)`: run both `evaluateSandboxPolicy(ctx)` and `evaluateWorkspaceScope(ctx)`; combine evidence; worst status wins.

`evaluateBudgetStart(ctx)` / `evaluateBudgetFinal(ctx)`: combine timeout + retry budget checks into one compound result.

- [ ] **Step 3: Merge final-only modules in the switch block**

```js
case "harness:collector.artifact":    // combines artifact_collector + diff_collector
case "harness:gate.artifact":         // combines artifact_required + stage_artifact_set + experiment_status + review_artifact
case "harness:gate.schema":           // combines schema_valid + stage_schema + review_finding_schema
case "harness:gate.test":             // test_pass_required (unchanged)
case "harness:normalizer.eval_input": // combines evaluation_input + stage_evaluation_input
case "harness:normalizer.failure":    // combines run_failure_classifier + review_verdict
```

Each merged case: evaluate all sub-checks, combine evidence objects, worst status wins.

- [ ] **Step 4: Update START_PENDING_MODULES set**

```js
const START_PENDING_MODULES = new Set([
  "harness:collector.artifact",
  "harness:gate.artifact",
  "harness:gate.test",
  "harness:normalizer.eval_input",
  "harness:normalizer.failure",
]);
```

- [ ] **Step 5: Verify evaluators load**

Run: `node -e "import('/Users/hakens/.openclaw/extensions/watchdog/lib/harness-module-evaluators.js').then(() => console.log('OK'))"`
Expected: OK (no import errors)

---

### Task 4: Update `parseHarnessModuleConfig` in registry

**Files:**
- Modify: `extensions/watchdog/lib/harness-registry.js:360-429`

- [ ] **Step 1: Update switch cases to new module IDs**

```js
case "harness:guard.budget":
  moduleConfig[normalizedModuleId] = {
    budgetSeconds: normalizePositiveInteger(config.budgetSeconds || config.timeoutSeconds, null),
    maxRetry: normalizeNonNegativeInteger(config.maxRetry || config.retryBudget, null),
  };
  break;
case "harness:guard.tool_access":
  moduleConfig[normalizedModuleId] = {
    allowedTools: uniqueTools(config.allowedTools || config.tools || []),
    mode: normalizeString(config.mode || config.matchMode)?.toLowerCase() || "subset",
    allowNetwork: config.allowNetwork == null ? null : normalizeBoolean(config.allowNetwork),
    allowedDomains: uniqueStrings(config.allowedDomains || config.domains || []),
  };
  break;
case "harness:guard.scope":
  moduleConfig[normalizedModuleId] = {
    policy: normalizeString(config.policy || config.mode || config.scope)?.toLowerCase() || null,
    allowedWorkspaceRoots: uniqueStrings(config.allowedWorkspaceRoots || config.allowedRoots || config.roots || []),
  };
  break;
```

- [ ] **Step 2: Resolve legacy module IDs in config parsing**

At the top of `parseHarnessModuleConfig`, resolve legacy IDs before looking up:
```js
const resolvedModuleId = LEGACY_MODULE_ID_MAP[normalizedModuleId] ?? normalizedModuleId;
if (resolvedModuleId === null) continue; // deleted module
if (!getHarnessModule(resolvedModuleId)) { ... }
```

---

### Task 5: Update harness-module-evidence.js

**Files:**
- Modify: `extensions/watchdog/lib/harness-module-evidence.js`

- [ ] **Step 1: Update `getModuleDefinition` to resolve legacy IDs**

```js
export function getModuleDefinition(moduleId) {
  return getHarnessModule(moduleId); // already handles legacy via resolveModuleId
}
```

- [ ] **Step 2: Update `resolveHarnessModuleConfig` if it references old IDs**

Check and update any hardcoded old module ID strings.

- [ ] **Step 3: Update `listModuleIds` to deduplicate after legacy resolution**

When a harness run has old IDs like `["timeout_guard", "retry_budget_guard"]`, both resolve to `"harness:guard.budget"`. Deduplicate:
```js
export function listModuleIds(run) {
  const raw = Array.isArray(run?.moduleRuns)
    ? run.moduleRuns.map(m => m?.moduleId).filter(Boolean)
    : Array.isArray(run?.moduleRefs) ? run.moduleRefs : [];
  const resolved = raw.map(id => resolveModuleId(id)).filter(Boolean);
  return [...new Set(resolved)];
}
```

---

### Task 6: Update pipeline-harness.js

**Files:**
- Modify: `extensions/watchdog/lib/pipeline-harness.js`

- [ ] **Step 1: Update profile reference**

The `stage.completion` profile ID stays the same. But if code references individual module IDs, update them to new IDs.

Search for any hardcoded old module IDs and replace.

---

### Task 7: Update dashboard files

**Files:**
- Modify: `extensions/watchdog/dashboard-harness-shared.js`
- Modify: `extensions/watchdog/dashboard-harness-atlas.js`
- Modify: `extensions/watchdog/dashboard-harness-placement.js`
- Modify: `extensions/watchdog/dashboard-devtools-management.js`

- [ ] **Step 1: Update kind display**

Old `completion_gate` → new `gate`. Update any UI labels or CSS class selectors that reference old kind names.

- [ ] **Step 2: Update module ID display parsing**

If the dashboard splits module IDs for display (e.g. showing `timeout_guard` as "Timeout Guard"), update to parse `harness:guard.budget` format — display after last `.` as label, use namespace for grouping.

---

### Task 8: Update tests

**Files:**
- Modify: `extensions/watchdog/tests/review-harness-modules.test.js`
- Modify: `extensions/watchdog/tests/harness-run-store.test.js`
- Modify: `extensions/watchdog/tests/automation-harness-projection.test.js`

- [ ] **Step 1: Update all module ID strings in test data**

Replace old IDs with new IDs. If tests verify module counts, update expected counts (22→10).

- [ ] **Step 2: Add test for legacy ID resolution**

```js
test("legacy module IDs resolve to new IDs", () => {
  assert.strictEqual(resolveModuleId("timeout_guard"), "harness:guard.budget");
  assert.strictEqual(resolveModuleId("artifact_collector"), "harness:collector.artifact");
  assert.strictEqual(resolveModuleId("code_quality_gate"), null); // deleted
  assert.strictEqual(resolveModuleId("harness:guard.budget"), "harness:guard.budget"); // new ID passes through
});
```

---

### Task 9: Gateway restart + smoke test

- [ ] **Step 1: Restart gateway**

```bash
openclaw gateway stop; sleep 3
lsof -ti:18789 | xargs kill -9 2>/dev/null; sleep 2
rm -f ~/.openclaw/.gateway.lock
HTTPS_PROXY=http://127.0.0.1:8080 HTTP_PROXY=http://127.0.0.1:8080 nohup openclaw gateway run > /tmp/openclaw-gateway.log 2>&1 &
sleep 10
head -50 /tmp/openclaw-gateway.log | strings | grep -iE 'error|Cannot find|import'
```

Expected: No import errors.

- [ ] **Step 2: Run single test**

```bash
curl -s -X POST "http://localhost:18789/watchdog/reset?token=TOKEN" -H "Content-Type: application/json" -d '{"explicitConfirm":true}'
node extensions/watchdog/test-runner.js --preset single
```

Expected: 1/1 PASS.

- [ ] **Step 3: Verify harness dashboard API**

```bash
curl -s "http://localhost:18789/watchdog/harness?token=TOKEN" | python3 -c "import sys,json; d=json.load(sys.stdin); print('modules:', d.get('counts',{}).get('modules',0))"
```

Expected: `modules: 10`

- [ ] **Step 4: Commit + push + tag**

```bash
git add extensions/watchdog/
git commit -m "refactor: harness模块合并22→10，harness:命名空间，删空壳，mode改推导"
HTTPS_PROXY=http://127.0.0.1:8080 git push
git tag v67-stable
HTTPS_PROXY=http://127.0.0.1:8080 git push origin v67-stable
```
