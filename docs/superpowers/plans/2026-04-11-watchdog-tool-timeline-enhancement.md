# Watchdog Tool Timeline Enhancement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend `watchdog` so `track_progress` carries structured, runtime-observed tool timeline entries and the dashboard event stream can render richer execution detail than `lastLabel` alone.

**Architecture:** Keep `watchdog` as the single observation path. `after_tool_call` will summarize each real tool completion into a bounded structured event list stored on tracking state, `buildProgressPayload()` will expose that list without introducing a second truth path, and `dashboard.js` will render the most recent structured event when present while keeping `lastLabel` as the compact fallback.

**Tech Stack:** Node.js ESM, built-in `node:test`, OpenClaw watchdog SSE dashboard

---

### Task 1: Freeze Structured Tool Timeline Behavior in Tests

**Files:**
- Modify: `extensions/watchdog/tests/task-stage-runtime.test.js`
- Modify: `extensions/watchdog/tests/dashboard-stage-visibility.test.js`

- [ ] **Step 1: Write the failing payload test**

```js
test("buildProgressPayload exposes recent structured tool events", () => {
  const trackingState = createTrackingState({
    sessionKey: "agent:worker:tool-stream",
    agentId: "worker",
    parentSession: null,
  });

  trackingState.toolCallTotal = 3;
  trackingState.lastLabel = "写入: result.md";
  trackingState.recentToolEvents = [
    {
      index: 3,
      tool: "write",
      label: "写入: result.md",
      status: "ok",
      summary: "写入 result.md",
      durationMs: 42,
      ts: 123,
    },
  ];

  const payload = buildProgressPayload(trackingState);

  assert.equal(Array.isArray(payload.recentToolEvents), true);
  assert.equal(payload.recentToolEvents.length, 1);
  assert.equal(payload.recentToolEvents[0].summary, "写入 result.md");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
cd /Users/hakens/.config/superpowers/worktrees/openclaw/codex-tool-timeline-watchdog
node --test extensions/watchdog/tests/task-stage-runtime.test.js
```

Expected: FAIL because `buildProgressPayload()` does not expose `recentToolEvents`.

- [ ] **Step 3: Write the failing dashboard rendering test**

```js
test("track_progress event stream prefers structured tool timeline summary", () => {
  dashboard.processEvent("track_progress", {
    sessionKey: "agent:worker:tool-stream",
    agentId: "worker",
    toolCallCount: 4,
    lastLabel: "执行: npm test",
    recentToolEvents: [
      {
        index: 4,
        tool: "exec",
        status: "ok",
        summary: "执行 npm test",
        ts: Date.now(),
      },
    ],
    ts: Date.now(),
  });

  const item = dashboard.agentEvents.worker?.[0];
  assert.match(item?.body || "", /执行 npm test/);
});
```

- [ ] **Step 4: Run test to verify it fails**

Run:

```bash
cd /Users/hakens/.config/superpowers/worktrees/openclaw/codex-tool-timeline-watchdog
node --test extensions/watchdog/tests/dashboard-stage-visibility.test.js
```

Expected: FAIL because `dashboard.js` still renders `#N ${lastLabel}` only.

---

### Task 2: Add Structured Tool Timeline to Tracking State and SSE Payload

**Files:**
- Modify: `extensions/watchdog/lib/session-bootstrap.js`
- Modify: `extensions/watchdog/lib/store/tracker-store.js`
- Modify: `extensions/watchdog/lib/transport/sse.js`
- Modify: `extensions/watchdog/hooks/after-tool-call.js`
- Create: `extensions/watchdog/lib/tool-timeline.js`

- [ ] **Step 1: Add tracking-state storage for recent tool events**

```js
export function createTrackingState({ sessionKey, agentId, parentSession }) {
  return {
    sessionKey,
    agentId,
    parentSession,
    startMs: Date.now(),
    toolCalls: [],
    recentToolEvents: [],
    toolCallTotal: 0,
    lastLabel: "启动中",
    // ...
  };
}
```

- [ ] **Step 2: Build structured tool event summaries from real tool completion data**

```js
const toolEvent = buildToolTimelineEvent({
  index: t.toolCallTotal,
  toolName,
  params,
  result: event.result,
  error: event.error,
  durationMs: event.durationMs,
  runId: ctx.runId,
  toolCallId: ctx.toolCallId,
  observedAt,
});

if (toolEvent) {
  if (t.recentToolEvents.length >= MAX_RECENT_TOOL_EVENTS) t.recentToolEvents.shift();
  t.recentToolEvents.push(toolEvent);
}
```

- [ ] **Step 3: Thread the structured field through SSE snapshots**

```js
return {
  sessionKey: t.sessionKey,
  toolCallCount: t.toolCallTotal,
  lastLabel: t.lastLabel,
  recentToolEvents: Array.isArray(t.recentToolEvents)
    ? t.recentToolEvents.map((entry) => ({ ...entry }))
    : [],
  // ...
};
```

- [ ] **Step 4: Run the focused payload test**

Run:

```bash
cd /Users/hakens/.config/superpowers/worktrees/openclaw/codex-tool-timeline-watchdog
node --test extensions/watchdog/tests/task-stage-runtime.test.js
```

Expected: PASS for the new payload assertion.

---

### Task 3: Render the Richer Timeline in Dashboard Without Forking Truth

**Files:**
- Modify: `extensions/watchdog/dashboard.js`
- Modify: `extensions/watchdog/tests/dashboard-stage-visibility.test.js`

- [ ] **Step 1: Prefer the most recent structured tool event in event-stream rendering**

```js
function getLatestToolTimelineEvent(data) {
  if (!Array.isArray(data?.recentToolEvents) || data.recentToolEvents.length === 0) return null;
  return data.recentToolEvents[data.recentToolEvents.length - 1] || null;
}

function buildTrackProgressBody(data) {
  const latestEvent = getLatestToolTimelineEvent(data);
  const text = latestEvent?.summary || latestEvent?.label || data.lastLabel || "";
  return `#${data.toolCallCount} ${esc(normalizeDashboardText(text))}`;
}
```

- [ ] **Step 2: Preserve the structured event list on in-memory work item state**

```js
workItems[sessionKey] = {
  ...existing,
  recentToolEvents: Array.isArray(data.recentToolEvents) ? data.recentToolEvents : existing.recentToolEvents || [],
};
```

- [ ] **Step 3: Run the focused dashboard test**

Run:

```bash
cd /Users/hakens/.config/superpowers/worktrees/openclaw/codex-tool-timeline-watchdog
node --test extensions/watchdog/tests/dashboard-stage-visibility.test.js
```

Expected: PASS and rendered event body shows structured summary instead of a bare fallback label when available.

---

### Task 4: Verify the Whole Slice and Check for Residual Drift

**Files:**
- Modify: `extensions/watchdog/tests/task-stage-runtime.test.js`
- Modify: `extensions/watchdog/tests/dashboard-stage-visibility.test.js`
- Modify: `extensions/watchdog/lib/tool-timeline.js`
- Modify: `extensions/watchdog/hooks/after-tool-call.js`
- Modify: `extensions/watchdog/lib/transport/sse.js`
- Modify: `extensions/watchdog/dashboard.js`

- [ ] **Step 1: Run both targeted suites together**

Run:

```bash
cd /Users/hakens/.config/superpowers/worktrees/openclaw/codex-tool-timeline-watchdog
node --test \
  extensions/watchdog/tests/task-stage-runtime.test.js \
  extensions/watchdog/tests/dashboard-stage-visibility.test.js
```

Expected: PASS.

- [ ] **Step 2: Search for remaining raw `lastLabel`-only progress rendering assumptions**

Run:

```bash
cd /Users/hakens/.config/superpowers/worktrees/openclaw/codex-tool-timeline-watchdog
rg -n "track_progress|lastLabel" extensions/watchdog
```

Expected: Remaining `lastLabel` references are compact fallbacks or unrelated runtime status labels, not a parallel truth path for tool timeline rendering.

- [ ] **Step 3: Review for accidental stage semantics bleed**

Check:
- no new stage inference code
- no semantic matcher tables
- no agent self-report fields introduced as truth
- only runtime-observed tool completion data added

---

## Execution Status (2026-04-11)

Implemented and synced into the main repo at `/Users/hakens/.openclaw`.

Completed:

- Added runtime-observed `recentToolEvents` flow through `after_tool_call -> tracking state -> SSE -> dashboard`.
- Added `extensions/watchdog/lib/tool-timeline.js` to summarize real tool completions into bounded structured timeline entries.
- Updated dashboard rendering to prefer the latest structured tool summary while keeping `lastLabel` as fallback only.
- Fixed `extensions/watchdog/tests/dashboard-stage-visibility.test.js` noise by stubbing `fetch()` in the test harness so `loadGraph()` does not emit Node relative-URL warnings during module bootstrap.

Verification in main repo:

```bash
cd /Users/hakens/.openclaw
node --test \
  extensions/watchdog/tests/tool-progress-payload.test.js \
  extensions/watchdog/tests/dashboard-stage-visibility.test.js \
  extensions/watchdog/tests/tool-timeline.test.js
```

Result: PASS (`20/20`).

```bash
cd /Users/hakens/.openclaw
node --test \
  extensions/watchdog/tests/harness-run-dedup.test.js \
  extensions/watchdog/tests/harness-run-store.test.js \
  extensions/watchdog/tests/review-context-payload.test.js \
  extensions/watchdog/tests/review-harness-modules.test.js \
  extensions/watchdog/tests/evaluator-result.test.js
```

Result: PASS (`27/27`).

```bash
cd /Users/hakens/.openclaw
node extensions/watchdog/test-runner.js --preset single
```

Result: PASS in `58.9s`, contract `TC-1775855387750`, output at `workspaces/controller/output/TC-1775855387750.md`.

```bash
cd /Users/hakens/.openclaw
node extensions/watchdog/test-runner.js --preset multi
```

Result: `1/3 PASSED`.

- `simple-03`: PASS
- `complex-02`: `E_TIMEOUT` at the preset's `180s` window, but timeline progressed `planner -> worker -> worker2`
- `complex-03`: `E_TIMEOUT` at the preset's `180s` window, but timeline progressed `planner -> worker` with continuous tool activity

Residual checks:

- `rg -n "track_progress|lastLabel" extensions/watchdog` shows `lastLabel` remains as compact fallback / runtime status text, not a second structured tool timeline truth path.
- No stage inference, semantic matcher tables, or agent self-reported stage truth were added in this slice.
