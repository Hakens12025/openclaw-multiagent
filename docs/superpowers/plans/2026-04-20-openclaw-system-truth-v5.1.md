# OpenClaw System Truth V5.1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove all remaining system-truth splits across managed guidance, bridge coordination, QQ dispatch compatibility, heartbeat pending-signal gating, wake semantics, legacy startup overwrite behavior, and controller ownership, with every compatibility layer, migration step, evidence source, and removal condition explicitly defined in this same document.

**Architecture:** This is a closed replacement program, not a safe-slice roadmap. Every compatibility layer introduced or preserved in this plan also has a named migration path and a named deletion path in this same plan. Runtime truth moves out of workspace drift, plugin-private dispatch markers, natural-language wake strings, unconditional gateway wakeups, and mailbox-scoped loop state into explicit role policy, operator-visible evidence stores, typed envelopes, source-owned pending-signal authority, and execution-epoch-aware hard-stop state.

**Tech Stack:** Node.js, OpenClaw watchdog plugin, QQ bridge plugin, admin surfaces, SSE/operator snapshot, runtime lifecycle/store modules, harness/unit/manual verification.

---

## Revision Delta From V5

This revision closes the eleven unresolved gaps from `v5`:

- `system-action` stays a single semantic skill id; role subsets are implemented by formal action projection and runtime enforcement, not by splitting skill ids.
- Wake envelope work now includes transport producers, heartbeat fallback payloads, ingress classification, and typed consumer paths, not only `runtime-wake-transport.js`.
- Pending-signal registry now has explicit source-owned clear authority, boot-time rehydrate, and stale backstop semantics.
- Loop epoch migration now uses one canonical epoch-key helper and updates every blocking, terminal, and cleanup callsite.
- Controller split now includes migration of runtime-owned control-plane stores that still live under `workspaces/controller`.
- Guidance takeover backups now have a retention policy and periodic safety prune.
- Wake envelope is now a discriminated schema with required fields per semantic type, not just an enum.
- `MAX_TOOL_CALLS` moves into `executionPolicy.maxToolCalls`; the existing bare constant is only a compat fallback and must be removed before Task 8 exits.
- Guidance legacy retirement now uses a durable drift evidence store with `emptySince`, not an uncomputable "N days empty" phrase.
- `Task 6` is now strictly sequenced after `Task 5`; no fake D/E parallelism remains.
- Any task that introduces an API, enum, or exit gate now also defines ownership, schema, and evidence source.

## End State

- Managed guidance truth is runtime-owned and marker-managed. Startup sync never overwrites non-marker custom docs.
- Bridge coordination truth is runtime-owned and role-scoped. Platform truth uses `[ACTION] delegate`; QQ-private `[DISPATCH]` is removed.
- Wake truth is typed. Natural-language wake text is a rendered explanation only.
- Gateway heartbeat truth is signal-driven. No gateway agent is implicitly actionable.
- Hard-stop truth is explicit, reasoned, operator-visible, harness-visible, and keyed by execution epoch rather than mailbox identity alone.
- Controller truth is decomposed. WebUI ingress bridge, platform operator, and any persona agent are separate runtime identities with separate stores.

## Program Rules

- No plan-external gradualism. If a task introduces or preserves a compatibility layer, this plan must also define the migration and deletion steps.
- No runtime truth may exist only in prompt text, plugin-private marker syntax, or informal operator knowledge.
- Any runtime behavior change touching `harness`, `operator`, `CLI system`, or `automation` must update all four layers in the same task.
- `SOUL.md` carries role boundary and posture. Runtime protocol truth lives in stores, typed envelopes, capability policy, and managed platform docs.
- An API signature without a clear owner for produce/consume/clear is incomplete.
- An enum without a discriminated schema is incomplete.
- An exit gate without a durable evidence source is incomplete.
- A backup or compatibility store without retention or deletion policy is incomplete.
- If a task declares a prerequisite, the dependent task does not run in parallel.
- Reuse existing config and policy surfaces unless a new config domain is required by the formal end state.

## Compatibility Ledger

| Compatibility Layer | Introduced / Kept In | Removed In | Removal Gate |
| --- | --- | --- | --- |
| Existing execution-role legacy SOUL auto-upgrade (`planner/executor/researcher/reviewer`) | Kept in Task 1 | Removed in Task 7 | `guidance-drift-state.emptySince` proves marker-managed fleet stability for 7 days, explicit takeover backups are healthy, no configured agent still depends on legacy auto-upgrade |
| QQ dual parser (`[DISPATCH]` + `[ACTION] delegate`) | Introduced in Task 4 | Removed in Task 4 | Both live bridge agents are marker-managed bridge docs, compat store shows no post-cutover legacy dispatch, and at least 100 successful post-cutover `[ACTION]` dispatches completed |
| Gateway heartbeat fallback (`identity.gateway => true`) | Kept while Task 5 is wired | Removed in Task 5 | All pending sources are wired, boot-time rehydrate works, operator snapshot exposes active/stale signal counts, and harness/manual checks prove no missed wakes |
| Natural-language wake text render view | Kept while Task 6 lands | Removed in Task 6 | All watchdog-owned wake producers and consumers carry typed envelopes end-to-end; ingress/runtime no longer classify semantics from strings |
| Bare global `MAX_TOOL_CALLS` constant | Kept as compat fallback in Task 8 introduction | Removed in Task 8 | All configured agents have an effective `executionPolicy.maxToolCalls`; runtime no longer reads the bare fallback for active agents |
| Legacy `controller` mixed identity alias | Kept while Task 8 migrates routes and stores | Removed in Task 8 | WebUI ingress, platform operator, control-plane stores, reply targets, admin surfaces, and tests are migrated off the old mixed identity |

## Formal Evidence Sources

The following durable evidence sources are part of the runtime truth model:

- `guidance-drift-state`
  - Fields: `lastScanAt`, `label`, `driftCount`, `driftedFiles`, `emptySince`, `scanSource`
  - Used by Tasks 1 and 7
- `qq-dispatch-compat-state`
  - Fields: `cutoverAt`, `actionDispatchCountSinceCutover`, `legacyDispatchCountSinceCutover`, `lastLegacySeenAt`, `lastActionSeenAt`
  - Used by Task 4
- `pending-signal-state`
  - Fields: `activeSignals`, `staleSignals`, `lastRehydratedAt`, `sourceCoverage`
  - Used by Task 5
- `wake-envelope-schema`
  - Discriminated union with per-type required fields
  - Used by Task 6
- `execution-epoch key`
  - Canonical key: `${sessionKey}:${runId}`
  - Used by Tasks 2 and 8

## Canonical Wake Envelope Schema

Every runtime wake envelope uses this base shape:

```json
{
  "version": 1,
  "semanticType": "execution_contract",
  "targetAgentId": "worker-a",
  "createdAt": 1760000000000,
  "renderText": "执行合约 TC-123：请读取 inbox/contract.json 并按当前系统派工执行任务"
}
```

Required fields by `semanticType`:

| semanticType | Required Fields | Optional Fields |
| --- | --- | --- |
| `execution_contract` | `contractId` | `sessionKeyHint` |
| `direct_request_resume` | `envelopeId` | `sessionKeyHint`, `sourceAgentId` |
| `system_action_wake_agent` | `sourceAgentId`, `actionType` | `deliveryTicketId`, `reason` |
| `assign_task_dispatch` | `sourceAgentId`, `deliveryTicketId` | `contractId`, `sourceContractId` |
| `request_review_dispatch` | `sourceAgentId`, `deliveryTicketId` | `contractId`, `sourceContractId` |
| `terminal_delivery_ready` | `deliveryId`, `contractId` | `sourceAgentId` |
| `system_action_delivery_resume` | `deliveryTicketId` | `sourceAgentId`, `contractId` |
| `heartbeat_poll` | none beyond base shape | `sourceAgentId` |
| `generic` | none beyond base shape | `reason` |

If a producer cannot satisfy the required fields for a semantic type, it must not emit that semantic type.

## Program Order

1. Task 1 lays foundations: managed bridge template, drift visibility, durable drift evidence, explicit takeover backups with retention.
2. Task 2 makes hard-stop state reasoned and observable.
3. Task 3 introduces the formal bridge coordination layer and role-scoped action projection.
4. Task 4 migrates QQ and live bridge agents onto the formal layer, then removes `[DISPATCH]`.
5. Task 5 replaces "always actionable gateway" with a source-owned pending-signal registry plus rehydrate/clear semantics.
6. Task 6 replaces wake-string semantics with typed wake envelopes. Task 6 starts only after Task 5 completes.
7. Task 7 retires guidance legacy compatibility using the durable drift evidence introduced in Task 1.
8. Task 8 introduces execution epochs, migrates `maxToolCalls` into execution policy, removes the bare fallback, and splits controller ownership and control-plane stores.

---

### Task 1: Foundation Truth, Drift Evidence, And Backup Retention

**Goal:** Give the system a correct managed bridge template, make guidance drift visible in operator/CLI surfaces, persist drift evidence over time, and make takeover the explicit, backed-up, retention-governed write path for live docs.

**Files:**
- Create: `.openclaw/extensions/watchdog/lib/agent/agent-guidance-drift.js`
- Create: `.openclaw/extensions/watchdog/lib/agent/agent-guidance-drift-state.js`
- Modify: `.openclaw/extensions/watchdog/lib/soul-template-builder.js`
- Modify: `.openclaw/extensions/watchdog/lib/agent/agent-enrollment-discovery.js`
- Modify: `.openclaw/extensions/watchdog/lib/workspace-guidance-writer.js`
- Modify: `.openclaw/extensions/watchdog/lib/agent/agent-enrollment-guidance.js`
- Modify: `.openclaw/extensions/watchdog/lib/operator/operator-snapshot.js`
- Modify: `.openclaw/extensions/watchdog/index.js`
- Modify: `.openclaw/extensions/watchdog/lib/admin/admin-surface-input-fields.js`
- Modify: `.openclaw/extensions/watchdog/lib/admin/admin-surface-plan-hints.js`
- Test: `.openclaw/extensions/watchdog/tests/soul-template-builder.test.js`
- Test: `.openclaw/extensions/watchdog/tests/guidance-drift.test.js`
- Test: `.openclaw/extensions/watchdog/tests/agent-guidance-takeover.test.js`

- [ ] Add `buildBridgeSoulTemplate(agentId, role)` in `lib/soul-template-builder.js` and branch `buildSoulTemplate()` on `AGENT_ROLE.BRIDGE` before default fallback.
- [ ] Keep bridge template strict: direct conversation vs contract-backed work are distinct; forbid `IDENTITY.md`, `USER.md`, `MEMORY.md`, ad hoc protocol tags, cross-agent writes, and `openclaw.json`.
- [ ] Do **not** add `isLegacyBridgeSoulContent()`. Existing `controller` and `agent-for-kksl` live docs remain untouched until explicit takeover.
- [ ] Create a reusable role-aware scanner in `lib/agent/agent-guidance-drift.js` that computes drift from `getManagedGuidanceFilesForRole(role)` instead of scanning all seven files.
- [ ] Create a durable drift evidence store in `lib/agent/agent-guidance-drift-state.js` that records `lastScanAt`, `driftCount`, `driftedFiles`, and `emptySince`. Update semantics: on every scan, if `driftCount === 0` and `emptySince == null`, set `emptySince = Date.now()`; if `driftCount > 0`, set `emptySince = null` (reset-on-regression).
- [ ] Call the drift scanner from `index.js` before and after `syncAllRuntimeWorkspaceGuidance()`, emit `GUIDANCE_DRIFT/pre-sync` and `GUIDANCE_DRIFT/post-sync`, and persist both scan results into the drift state store.
- [ ] Add periodic drift scan on the existing maintenance interval so `emptySince` becomes a real measured fact rather than a startup-only guess.
- [ ] Extend `summarizeLocalAgentDiscovery()` so `GET /watchdog/agents/discovery` returns drift counts, drifted files, and current drift-state summary per agent.
- [ ] Extend `buildOperatorSnapshot()` so `/watchdog/operator-snapshot` includes guidance drift counts, drift attention items, `emptySince`, and direct links to `agents.discovery` / `agents.guidance.takeover`.
- [ ] Extend `takeOverLocalAgentGuidance()` to accept `backup` (default `true`), copy target files into `workspaces/<agentId>/.guidance-backup/<ISO-ts>/`, and return `scanBefore`, `scanAfter`, and `backupPaths`.
- [ ] After each successful takeover, prune `.guidance-backup` for that agent to the most recent 10 snapshots. This keep-last-10 rule is the authoritative retention policy.
- [ ] Add periodic safety prune in `index.js` so stray backup accumulation is cleaned up even if takeover exits early.
- [ ] Extend `admin-surface-input-fields.js` and `admin-surface-plan-hints.js` so the takeover surface visibly exposes backup behavior, backup retention, and drift deltas in operator/change-set previews.
- [ ] Keep existing startup auto-upgrade behavior for the four execution-role legacy fingerprints unchanged in this task. Task 1 documents and exposes that compatibility layer; it does not widen it.

**Formal Output Of Task 1**

- New bridge agents get a managed bridge SOUL.
- Existing `controller` / `kksl` are not silently overwritten.
- Drift is visible in logs, discovery, operator snapshot, and takeover responses.
- Drift evidence now has a durable `emptySince` clock.
- Guidance backups no longer grow without bound.

**Task 1 Tests**

- [ ] `buildSoulTemplate(role=BRIDGE)` returns bridge template, not default template.
- [ ] Bridge template contains the managed marker and does not mention `[ACTION]`, `[DISPATCH]`, `IDENTITY.md`, or `USER.md`.
- [ ] Drift scan only checks `SOUL.md` + `HEARTBEAT.md` for execution-layer roles.
- [ ] Drift scan checks all role-managed files for bridge/agent roles.
- [ ] Drift state store sets `emptySince` only when drift count reaches zero and preserves it across later scans.
- [ ] Drift state store **resets `emptySince` to `null` as soon as any later scan observes `driftCount > 0`**. This reset-on-regression rule is load-bearing for Task 7: without it the 7-day removal gate can false-pass after drift reappears.
- [ ] Drift state store persists `emptySince` across process restart (write state, simulate restart by reloading the store module/state file, assert `emptySince` is unchanged and still satisfies `Date.now() - emptySince` monotonic growth). This is the load-bearing test for the Task 7 7-day removal gate.
- [ ] Drift state store restart + regression test: `emptySince` set → restart → drift reappears → confirm `emptySince` resets to `null` and must re-earn the empty clock from zero.
- [ ] `takeOverLocalAgentGuidance({ backup: true })` creates `.guidance-backup/<ts>/...`.
- [ ] Backup prune keeps the latest 10 snapshots per agent.
- [ ] Takeover response contains `scanBefore`, `scanAfter`, and `backupPaths`.

**Task 1 Exit Gate**

- `controller` and `kksl` still show drift until explicit takeover.
- Operator can see drift and `emptySince` without reading raw logs.
- Guidance backups are bounded by policy.
- No new bridge legacy auto-overwrite path exists.

---

### Task 2: Hard-Stop Truth And Runtime Diagnostics

**Goal:** Make hard-stop state explicit, reasoned, operator-visible, and harness-visible before additional enforcement sources reuse it.

**Files:**
- Modify: `.openclaw/extensions/watchdog/lib/loop/loop-detection.js`
- Modify: `.openclaw/extensions/watchdog/hooks/after-tool-call.js`
- Modify: `.openclaw/extensions/watchdog/lib/lifecycle/agent-end-graph-route.js`
- Modify: `.openclaw/extensions/watchdog/lib/lifecycle/agent-end-terminal.js`
- Modify: `.openclaw/extensions/watchdog/lib/store/execution-trace-store.js`
- Modify: `.openclaw/extensions/watchdog/lib/operator/operator-snapshot.js`
- Test: `.openclaw/extensions/watchdog/tests/loop-detection.test.js`
- Test: `.openclaw/extensions/watchdog/tests/agent-end-graph-route.test.js`
- Test: `.openclaw/extensions/watchdog/tests/after-tool-call-loop-warning.test.js`

- [ ] Add `markSessionHardStopped(epochKey, reason)` and `getSessionHardStopReason(epochKey)` to `lib/loop/loop-detection.js`. In Task 2, `epochKey === sessionKey`; Task 8 upgrades the keyspace.
- [ ] Extend loop session state to include `hardStopReason`; keep `isSessionHardStopped()` behavior unchanged.
- [ ] Refactor `trackToolCall()` so the repeated-hash threshold uses `markSessionHardStopped(epochKey, "repeat_threshold")` instead of mutating `hardStopped` inline.
- [ ] Update `resolveGraphTerminalGate()` so `terminalOutcome.reason` is `getSessionHardStopReason(epochKey) || "loop_detected"`.
- [ ] Update `agent-end-terminal.js` harness metadata so `completionReason` and warning details use the stored hard-stop reason instead of a hardcoded `loop_detected` boolean path.
- [ ] Extend `after-tool-call.js` `loop_warning` payload with `agentRole`, `contractId`, `elapsedMs`, and `toolCallTotalAfter`.
- [ ] Resolve the `toolCallTotalAfter` timing from actual code order. If broadcast fires before `toolCallTotal++`, add `+1`; if after, do not.
- [ ] Extend `execution-trace-store.js` to retain enough per-trace call-hash frequency metadata for harness/operator diagnostics, so repeat-loop vs random-thrash analysis uses watchdog data rather than proxy request logs.
- [ ] Surface recent hard-stop reasons in operator snapshot attention items.

**Formal Output Of Task 2**

- Hard-stop reason is a first-class runtime fact.
- Repeated hash hard-stops report `repeat_threshold`, not a lossy `loop_detected` placeholder.
- Harness and operator can see why a session hard-stopped.

**Task 2 Tests**

- [ ] `markSessionHardStopped("k", "manual")` sets reason to `manual`.
- [ ] Repeated identical tool call threshold sets reason to `repeat_threshold`.
- [ ] Graph terminal gate returns `terminalOutcome.reason === "repeat_threshold"` for repeat-loop case.
- [ ] Harness/terminal completion reason matches stored hard-stop reason.
- [ ] `loop_warning.toolCallTotalAfter` reflects post-call count.

**Task 2 Exit Gate**

- Every current hard-stop path is reason-carrying and visible.
- No caller needs to guess whether a hard stop was loop-threshold, manual stop, or future `max_tool_calls`.

---

### Task 3: Formal Bridge Coordination Layer

**Goal:** Replace the "bridge has no formal coordination protocol" gap with a runtime-owned, role-scoped bridge coordination model that does not widen bridge permissions accidentally.

**Files:**
- Create: `.openclaw/extensions/watchdog/lib/system-action/system-action-role-policy.js`
- Modify: `.openclaw/extensions/watchdog/lib/agent/agent-metadata.js`
- Modify: `.openclaw/extensions/watchdog/lib/semantic-skill-registry.js`
- Modify: `.openclaw/extensions/watchdog/lib/platform-doc-builder.js`
- Modify: `.openclaw/extensions/watchdog/lib/system-action/system-action-consumer.js`
- Modify: `.openclaw/extensions/watchdog/lib/system-action/system-action-runtime.js`
- Modify: `.openclaw/extensions/watchdog/lib/soul-template-builder.js`
- Modify: `.openclaw/extensions/watchdog/lib/capability/capability-preset-registry.js`
- Test: `.openclaw/extensions/watchdog/tests/system-action-role-policy.test.js`
- Test: `.openclaw/extensions/watchdog/tests/bridge-system-action-boundary.test.js`

- [ ] Keep a single semantic skill id: `system-action`. Do **not** split it into multiple skill ids.
- [ ] Introduce `system-action-role-policy.js` as the single runtime source of truth for allowed actions per role.
- [ ] Canonical action matrix for this plan:
  - `bridge`: `assign_task`
  - `planner`: `assign_task`, `request_review`, `advance_loop`
  - `executor`: `request_review`
  - `researcher`: `request_review`
  - `reviewer`: `request_review`, `advance_loop`
  - `agent`: `assign_task`, `request_review`, `wake_agent`, `start_loop`, `advance_loop`
- [ ] Add `listAllowedActionTypesForRole(role)` and `isActionAllowedForRole(role, actionType)`.
- [ ] Update `semantic-skill-registry.js` so `system-action` remains the same injected skill id but can expose role-scoped action projection metadata.
- [ ] Update `platform-doc-builder.js` so managed docs render only the allowed action subset for the current role. A bridge that has `system-action` sees only delegate / `assign_task`.
- [ ] Add runtime enforcement in `system-action-consumer.js` and `system-action-runtime.js` so disallowed actions are rejected before any side effects occur.
- [ ] After runtime enforcement exists, update `buildBridgeSoulTemplate()` to teach exactly one formal dispatch idiom: `[ACTION] delegate <agentId> — <instruction>`.
- [ ] Add `AGENT_ROLE.BRIDGE` to `SYSTEM_ACTION_ENABLED_ROLES` only after role policy and runtime enforcement are in place.
- [ ] Update capability preset rules so bridge can emit `[ACTION] delegate` but does not inherit unrelated collaboration semantics.

**Formal Output Of Task 3**

- Bridge no longer relies on plugin-private dispatch syntax as the only coordination path.
- Bridge can only delegate; it cannot silently inherit the whole `system-action` surface.
- Skill id, docs, and runtime enforcement all agree on the same action subset.

**Task 3 Tests**

- [ ] Bridge role receives only `assign_task` from the action projection.
- [ ] Bridge-emitted `[ACTION] review ...` is rejected by runtime with role-policy error.
- [ ] Bridge-emitted `[ACTION] delegate ...` is accepted and routed through `assign_task`.
- [ ] Executor/planner/researcher/reviewer action behavior follows the formal matrix above.

**Task 3 Exit Gate**

- The formal bridge dispatch layer exists before live bridges are migrated.
- No undocumented action subset remains implicit.

---

### Task 4: QQ Compatibility Layer, Live Bridge Migration, And `[DISPATCH]` Removal

**Goal:** Migrate QQ and live bridge agents from plugin-private `[DISPATCH]` truth to the formal bridge coordination layer without breaking current traffic, then remove the compatibility layer.

**Files:**
- Create: `.openclaw/extensions/qqbot/src/dispatch-compat-state.ts`
- Modify: `.openclaw/extensions/qqbot/src/dispatch-marker.ts`
- Modify: `.openclaw/extensions/qqbot/src/gateway.ts`
- Modify: `.openclaw/extensions/watchdog/lib/operator/operator-snapshot.js`
- Modify: `.openclaw/extensions/watchdog/lib/agent/agent-enrollment-guidance.js`
- Modify: `.openclaw/extensions/watchdog/lib/formal-test-presets.js`
- Test: `.openclaw/extensions/watchdog/tests/qq-dispatch-compat.test.js`
- Test: `.openclaw/extensions/watchdog/tests/bridge-guidance-migration.test.js`
- Docs: `.openclaw/use guide/2026-04-20-controller-guidance-takeover-runbook.md`
- Docs: `.openclaw/use guide/2026-04-20-qq-bridge-migration-runbook.md`

- [ ] Introduce a **temporary** QQ dual parser: accept both legacy `[DISPATCH]...[/DISPATCH]` and formal `[ACTION] delegate ...` / assign-task JSON markers, but route both to the same contract-creation path.
- [ ] Add `dispatch-compat-state.ts` to persist `cutoverAt`, `actionDispatchCountSinceCutover`, `legacyDispatchCountSinceCutover`, `lastLegacySeenAt`, and `lastActionSeenAt`.
- [ ] Expose QQ dispatch compat state in operator snapshot so removal is based on measured data rather than log grep.
- [ ] Use the extended takeover surface from Task 1 to migrate `controller` from rogue persona docs to managed bridge docs.
- [ ] Verify `controller` drift is cleared, its backups exist, and its takeover did not exceed backup retention.
- [ ] Migrate `agent-for-kksl` (`kksl`) to managed bridge docs only after dual parser support is live.
- [ ] Mark the moment both bridges are migrated as `cutoverAt` in the compat state.
- [ ] Remove QQ-specific dispatch instructions from `kksl/SOUL.md` by replacing the live file via takeover, not by inventing a bridge legacy fingerprint.
- [ ] Update formal tests and runbooks so both bridge agents are expected to use the managed bridge template and formal dispatch syntax.
- [ ] Remove `[DISPATCH]` support only when post-cutover compat state shows:
  - `legacyDispatchCountSinceCutover === 0`
  - `actionDispatchCountSinceCutover >= 100`
  - `lastLegacySeenAt == null` or `lastLegacySeenAt < cutoverAt`
- [ ] After the gate is satisfied, delete `[DISPATCH]` parsing from the QQ plugin and remove compat comments/runbook steps that mention it.

**Formal Output Of Task 4**

- Live bridge agents are migrated onto managed bridge truth.
- QQ no longer depends on a workspace-private `[DISPATCH]` contract.
- `[DISPATCH]` is removed from code, not merely deprecated.

**Task 4 Tests**

- [ ] QQ plugin accepts `[ACTION] delegate ...` and produces the same contract flow as legacy `[DISPATCH]`.
- [ ] Controller takeover succeeds with backup and drift reduction.
- [ ] KKSL takeover succeeds after dual parser introduction.
- [ ] Compat state tracks post-cutover legacy/action counts correctly.
- [ ] No harness/manual QQ flow still requires `[DISPATCH]` after the removal gate is passed.

**Task 4 Exit Gate**

- `controller` and `kksl` are marker-managed bridge agents.
- QQ bridge task delegation works via formal bridge truth.
- `[DISPATCH]` parser code is removed.

---

### Task 5: Pending-Signal Registry, Rehydrate, And Heartbeat Gate Cutover

**Goal:** Replace "gateway agents are always actionable" with a formal pending-signal registry whose ownership, clear semantics, and boot-time rehydrate behavior are explicitly defined.

**Files:**
- Create: `.openclaw/extensions/watchdog/lib/runtime/pending-signal-registry.js`
- Create: `.openclaw/extensions/watchdog/lib/runtime/pending-signal-state.js`
- Create: `.openclaw/extensions/watchdog/lib/runtime/pending-signal-sources.js`
- Modify: `.openclaw/extensions/watchdog/lib/heartbeat-gate.js`
- Modify: `.openclaw/extensions/watchdog/lib/ingress/before-start-ingress.js`
- Modify: `.openclaw/extensions/watchdog/lib/runtime-direct-envelope-queue.js`
- Modify: `.openclaw/extensions/watchdog/lib/routing/delivery-system-action-ticket.js`
- Modify: `.openclaw/extensions/watchdog/lib/session-bootstrap.js`
- Modify: `.openclaw/extensions/watchdog/lib/automation/automation-runtime.js`
- Modify: `.openclaw/extensions/watchdog/lib/schedule/schedule-registry.js`
- Modify: `.openclaw/extensions/watchdog/lib/schedule/schedule-trigger.js`
- Modify: `.openclaw/extensions/watchdog/lib/operator/operator-snapshot.js`
- Modify: `.openclaw/extensions/watchdog/index.js`
- Modify: `.openclaw/extensions/qqbot/src/gateway.ts`
- Test: `.openclaw/extensions/watchdog/tests/pending-signal-registry.test.js`
- Test: `.openclaw/extensions/watchdog/tests/heartbeat-gate.test.js`

- [ ] Introduce a runtime-owned pending-signal registry keyed by `agentId + sourceKind + sourceRef`.
- [ ] Persist active signal state in `pending-signal-state` so operator snapshot can report active/stale counts.
- [ ] Define canonical signal kinds:
  - `channel_ingress:webui`
  - `channel_ingress:qq`
  - `channel_ingress:test_inject`
  - `runtime_direct_envelope`
  - `system_action_delivery`
  - `automation_due`
  - `schedule_due`
- [ ] Define one source-owned helper pair per signal source. The registry does **not** rely on arbitrary callers remembering to invoke a generic `clearPendingSignal()`:
  - direct envelope: register on enqueue, clear on promotion/consume
  - system-action delivery: register on active ticket, clear on ticket resolve
  - webui/qq/test ingress: register on inbound event, clear on successful materialization into runtime work
  - automation/schedule: register when due, clear on claim or explicit skip resolution
- [ ] TTL is only a stale backstop for `channel_ingress:*` signals. Durable sources are authoritative and must rehydrate from source state on boot.
- [ ] Add boot-time rehydrate in `index.js` so the registry reconstructs active signals from durable sources:
  - `runtime-direct-envelope-queue`
  - active `system-action-delivery` tickets
  - due automation/schedule work
- [ ] Update watchdog-owned ingress paths (`before-start-ingress`, test inject, WebUI hook hard-path) to register and resolve pending signals.
- [ ] Update QQ plugin to register a QQ pending signal when an inbound message arrives and resolve it only when the message has been materialized into runtime work.
- [ ] Update `runtime-direct-envelope-queue.js` and `delivery-system-action-ticket.js` so promotion/resolve paths automatically update the registry.
- [ ] Change `heartbeat-gate.js` to consult the registry first.
- [ ] Keep the old gateway `return true` branch only as an explicit compatibility fallback flag during rollout.
- [ ] Once all producers are wired and harness/manual checks prove no missed wakeups, delete the gateway fallback branch.

**Formal Output Of Task 5**

- Gateway actionability is a runtime fact backed by explicit signals.
- Clear responsibility is bound to produce/consume ownership, not caller discipline.
- Boot-time rehydrate makes pending-signal truth durable.

**Task 5 Tests**

- [ ] WebUI direct ingress creates a pending signal that heartbeat gate recognizes.
- [ ] QQ inbound message creates a pending signal that heartbeat gate recognizes.
- [ ] System-action delivery resume creates a pending signal and resolves it on ticket completion.
- [ ] Direct envelope queue rehydrates pending signals after restart.
- [ ] With no pending signal, gateway heartbeat returns not actionable.
- [ ] TTL expiry only marks stale `channel_ingress:*` signals and does not erase durable source truth.
- [ ] Removing the fallback still leaves QQ/WebUI/automation/system_action flows green.

**Task 5 Exit Gate**

- `heartbeat-gate.js` no longer contains unconditional `if (identity.gateway) return true`.
- Operator snapshot exposes active/stale signal counts and rehydrate status.
- Signal clear semantics are source-owned and tested.

---

### Task 6: Typed Wake Envelope And Structured Wake Semantics

**Goal:** Replace natural-language wake text as protocol truth with a typed wake envelope carried through hooks, heartbeat fallback, delivery resumes, direct-request resumes, and bridge dispatches.

**Files:**
- Create: `.openclaw/extensions/watchdog/lib/transport/runtime-wake-envelope.js`
- Modify: `.openclaw/extensions/watchdog/lib/transport/runtime-wake-transport.js`
- Modify: `.openclaw/extensions/watchdog/lib/ingress/before-start-ingress.js`
- Modify: `.openclaw/extensions/watchdog/lib/session-bootstrap.js`
- Modify: `.openclaw/extensions/watchdog/lib/lifecycle/runtime-diagnostics.js`
- Modify: `.openclaw/extensions/watchdog/lib/platform-doc-builder.js`
- Modify: `.openclaw/extensions/watchdog/lib/soul-template-builder.js`
- Modify: `.openclaw/extensions/watchdog/lib/routing/dispatch-transport.js`
- Modify: `.openclaw/extensions/watchdog/lib/routing/delivery-system-action-transport.js`
- Modify: `.openclaw/extensions/watchdog/lib/routing/delivery-terminal.js`
- Modify: `.openclaw/extensions/watchdog/lib/system-action/system-action-runtime.js`
- Modify: `.openclaw/extensions/watchdog/lib/lifecycle/crash-recovery.js`
- Test: `.openclaw/extensions/watchdog/tests/runtime-wake-envelope.test.js`
- Test: `.openclaw/extensions/watchdog/tests/runtime-wake-unification.test.js`
- Test: `.openclaw/extensions/watchdog/tests/direct-vs-contract-session-semantics.test.js`

- [ ] Introduce `runtime-wake-envelope.js` with `normalizeWakeEnvelope`, `buildRuntimeWakeEnvelope`, `validateWakeEnvelope`, and `renderWakeEnvelopeToText`.
- [ ] Encode the discriminated schema defined earlier in this document. Schema failure is a runtime error, not a soft fallback.
- [ ] Make `runtimeWakeAgentDetailed()` carry `{ wakeEnvelope, message: renderText }`; `renderText` remains for human diagnostics only.
- [ ] Update hooks-first wake dispatch payloads to include `wakeEnvelope`.
- [ ] Update heartbeat fallback payloads to include `wakeEnvelope` as the primary semantic carrier. `reason` remains only as compatibility render text during rollout.
- [ ] Update watchdog-owned consumers so they read structured envelope data first and only use string fallback on the temporary compatibility path.
- [ ] Update `before-start-ingress.js` so internal wake detection no longer relies on regex over Chinese strings once the compatibility path is removed.
- [ ] Update `session-bootstrap.js` and related wake consumers so direct-request vs execution-contract vs delivery resume are distinguished from envelope data, not inferred from text.
- [ ] Update managed platform docs and bridge template so they describe wake classes conceptually, not by memorizing literal wake strings.
- [ ] Add operator/harness diagnostics for `semanticType`, required ids, producer lane, and render text.
- [ ] Delete `isRuntimeWakeMessage()` and remaining string classification only after all watchdog-owned producers and consumers carry typed envelopes.

**Formal Output Of Task 6**

- Direct user chat vs execution contract vs system-action delivery are structurally distinct.
- Runtime no longer depends on models or regex correctly parsing a Chinese wake sentence.

**Task 6 Tests**

- [ ] Hooks wake path carries typed envelope plus render text.
- [ ] Heartbeat fallback path carries typed envelope plus render text.
- [ ] Session bootstrap chooses direct-request vs contract path from typed envelope, not text pattern.
- [ ] Each semantic type rejects missing required fields.
- [ ] Old string fallback can be removed without breaking formal flows.

**Task 6 Exit Gate**

- Typed wake envelope is the sole runtime truth.
- Natural-language wake text remains only a rendered explanation.
- `isRuntimeWakeMessage()` string matching is gone from watchdog-owned semantic paths.

---

### Task 7: Guidance Legacy Retirement

**Goal:** Remove guidance legacy auto-upgrade once all live agents are marker-managed or explicitly custom, so startup sync no longer has hidden overwrite behavior.

**Files:**
- Modify: `.openclaw/extensions/watchdog/lib/soul-template-builder.js`
- Modify: `.openclaw/extensions/watchdog/lib/workspace-guidance-writer.js`
- Modify: `.openclaw/extensions/watchdog/lib/agent/agent-enrollment-discovery.js`
- Modify: `.openclaw/extensions/watchdog/lib/agent/agent-guidance-drift-state.js`
- Modify: `.openclaw/extensions/watchdog/lib/operator/operator-snapshot.js`
- Test: `.openclaw/extensions/watchdog/tests/workspace-guidance-writer.test.js`
- Test: `.openclaw/extensions/watchdog/tests/legacy-guidance-retirement.test.js`

- [ ] Use the drift evidence from Task 1 to verify that all configured agents are either marker-managed or intentionally custom.
- [ ] Add an operator attention/report path that explicitly lists any remaining legacy-matched live docs before deletion.
- [ ] Delete `isLegacyPlannerSoulContent`, `isLegacyExecutorSoulContent`, `isLegacyResearcherSoulContent`, and `isLegacyReviewerSoulContent`.
- [ ] Delete startup auto-upgrade branches in `writeSoulFile()` that consume those legacy helpers.
- [ ] Keep marker-managed file updates intact.
- [ ] Keep explicit takeover intact.
- [ ] Update discovery/status semantics so "custom" means real custom, not "legacy file that startup will silently replace later."
- [ ] Use `guidance-drift-state.emptySince` as the removal evidence source. Task 7 removal gate is: `emptySince != null` and `Date.now() - emptySince >= 7d`.

**Formal Output Of Task 7**

- Startup sync only updates marker-managed docs.
- Any non-marker overwrite now requires explicit takeover.

**Task 7 Tests**

- [ ] Startup sync updates marker-managed docs.
- [ ] Startup sync no longer overwrites no-marker legacy docs.
- [ ] Explicit takeover still overwrites target files with backups.
- [ ] `emptySince` remains stable across repeated zero-drift scans.

**Task 7 Exit Gate**

- No startup path silently upgrades any non-marker file.
- Guidance overwrite policy is finally true-by-construction.

---

### Task 8: Execution Epoch, `executionPolicy.maxToolCalls`, And Controller Ownership Split

**Goal:** Separate mailbox identity from execution epoch, move tool-call hard-stop truth into formal execution policy, remove the bare `MAX_TOOL_CALLS` fallback, and split `controller` into distinct runtime identities and stores.

**Files:**
- Create: `.openclaw/extensions/watchdog/lib/loop/loop-epoch-key.js`
- Create: `.openclaw/extensions/watchdog/lib/control-plane/control-plane-paths.js`
- Modify: `.openclaw/extensions/watchdog/lib/session-bootstrap.js`
- Modify: `.openclaw/extensions/watchdog/lib/loop/loop-detection.js`
- Modify: `.openclaw/extensions/watchdog/hooks/before-tool-call.js`
- Modify: `.openclaw/extensions/watchdog/hooks/after-tool-call.js`
- Modify: `.openclaw/extensions/watchdog/lib/lifecycle/runtime-lifecycle.js`
- Modify: `.openclaw/extensions/watchdog/lib/lifecycle/agent-end-graph-route.js`
- Modify: `.openclaw/extensions/watchdog/lib/lifecycle/agent-end-terminal.js`
- Modify: `.openclaw/extensions/watchdog/lib/state-constants.js`
- Modify: `.openclaw/extensions/watchdog/lib/execution-policy-defaults.js`
- Modify: `.openclaw/extensions/watchdog/lib/agent/agent-binding-store.js`
- Modify: `.openclaw/extensions/watchdog/lib/effective-profile-composer.js`
- Modify: `.openclaw/extensions/watchdog/lib/agent/agent-admin-agent-operations.js`
- Modify: `.openclaw/extensions/watchdog/lib/admin/admin-surface-input-fields.js`
- Modify: `.openclaw/extensions/watchdog/lib/admin/admin-surface-plan-hints.js`
- Modify: `.openclaw/extensions/watchdog/lib/routing/delivery-system-action-ticket.js`
- Modify: `.openclaw/extensions/watchdog/lib/operator/operator-snapshot.js`
- Modify: `.openclaw/extensions/watchdog/lib/formal-test-presets.js`
- Modify: `.openclaw/extensions/watchdog/lib/agent/agent-metadata.js`
- Modify: `.openclaw/extensions/watchdog/lib/agent/agent-identity.js`
- Modify: `.openclaw/extensions/watchdog/index.js`
- Modify (shared path authority): `.openclaw/extensions/watchdog/lib/state-paths.js` — replace hardcoded `workspaces/controller` roots for `CONTRACTS_DIR`, `STATE_FILE`, `QUEUE_STATE_FILE` with derivations from `control-plane-paths.js`
- Modify (CONTRACTS_DIR/STATE_FILE/QUEUE_STATE_FILE consumers): `.openclaw/extensions/watchdog/lib/store/contract-store.js`, `.openclaw/extensions/watchdog/lib/contracts.js`, `.openclaw/extensions/watchdog/lib/routing/dispatch-runtime-state.js`, `.openclaw/extensions/watchdog/lib/state-persistence.js`, `.openclaw/extensions/watchdog/lib/admin/runtime-admin.js`
- Modify (controller-rooted runtime stores — closed inventory): `.openclaw/extensions/watchdog/lib/agent/agent-default-skills-store.js`, `.openclaw/extensions/watchdog/lib/admin/admin-change-sets.js`, `.openclaw/extensions/watchdog/lib/agent/agent-join-registry.js`, `.openclaw/extensions/watchdog/lib/agent/agent-graph.js`, `.openclaw/extensions/watchdog/lib/agent/agent-graph-mutations.js`, `.openclaw/extensions/watchdog/lib/loop/graph-loop-registry.js`, `.openclaw/extensions/watchdog/lib/loop/loop-round-runtime.js`, `.openclaw/extensions/watchdog/lib/automation/automation-runtime.js`, `.openclaw/extensions/watchdog/lib/automation/automation-registry.js`, `.openclaw/extensions/watchdog/lib/schedule/schedule-registry.js`, `.openclaw/extensions/watchdog/lib/schedule/schedule-materializer.js`, `.openclaw/extensions/watchdog/lib/routing/delivery-terminal.js`, `.openclaw/extensions/watchdog/lib/routing/runtime-mailbox-outbox-helpers.js`, `.openclaw/extensions/watchdog/lib/ingress/dispatch-execution-contract-entry.js`, `.openclaw/extensions/watchdog/lib/conversations.js`
- Test (existing, rerun): `.openclaw/extensions/watchdog/tests/retry-suspend-runtime-lifecycle.test.js`
- Test (existing, rerun): `.openclaw/extensions/watchdog/tests/loop-detection.test.js`
- Test (existing, must be updated — currently hardcode controller-rooted truth): `.openclaw/extensions/watchdog/tests/suite-agent-model.js` (around :705), `.openclaw/extensions/watchdog/tests/suite-operator.js` (around :1066 and :1184), `.openclaw/extensions/watchdog/tests/review-harness-modules.test.js` (around :79), `.openclaw/extensions/watchdog/tests/infra.js` (around :20 — shared test harness), `.openclaw/extensions/watchdog/tests/runtime-store-stability.test.js` (around :18), `.openclaw/extensions/watchdog/tests/contract-output-alias.test.js` (around :16 and :36), plus any other `watchdog/tests/**` file that grep flags for `workspaces/controller`.
- Test: `.openclaw/extensions/watchdog/tests/max-tool-calls-hard-stop.test.js`
- Test: `.openclaw/extensions/watchdog/tests/execution-policy-max-tool-calls.test.js`
- Test: `.openclaw/extensions/watchdog/tests/controller-split-migration.test.js`

- [ ] Introduce `loop-epoch-key.js` as the single helper for `buildLoopEpochKey(sessionKey, runId)` and `resolveLoopEpochKey(trackingState)`.
- [ ] Add `runId` / epoch to tracking state creation so each execution instance has its own loop key.
- [ ] Change loop-tracking keyspace from mailbox identity to `${sessionKey}:${runId}` and update every callsite that blocks, reads, writes, or clears loop state:
  - `before-tool-call`
  - `after-tool-call`
  - graph terminal gate
  - harness/agent-end terminal reporting
  - finalize cleanup
- [ ] Extend `executionPolicy` to include numeric `maxToolCalls`.
- [ ] Use the existing execution policy pipeline instead of inventing a new top-level `toolBudget` domain:
  - validation in `agent-binding-store.js`
  - merge in `effective-profile-composer.js`
  - defaults in `execution-policy-defaults.js`
  - admin patch path in `changeAgentPolicies()`
  - admin input field on `agents.policy`
- [ ] Keep the current bare `MAX_TOOL_CALLS` constant only as a compat fallback while agents are migrated to explicit `executionPolicy.maxToolCalls`.
- [ ] Wire `maxToolCalls` enforcement through `markSessionHardStopped(epochKey, "max_tool_calls")`.
- [ ] Remove the bare global fallback once all configured agents have an effective `executionPolicy.maxToolCalls`.
- [ ] Update summaries, alerts, and harness output so `max_tool_calls` and `repeat_threshold` are distinguishable.
- [ ] Introduce formal split identities:
  - `gateway-webui` for WebUI ingress bridge
  - `platform-operator` for operator/runtime management work
- [ ] Migrate the **closed set** of runtime-owned control-plane stores out of `workspaces/controller` into formal control-plane paths. This inventory is exhaustive for this plan; any additional controller-rooted writer discovered during execution must be added to this list, not handled out-of-band:
  1. Shared path authority (`state-paths.js`): `CONTRACTS_DIR`, `STATE_FILE` (`.watchdog-state.json`), `QUEUE_STATE_FILE` (`.queue-state.json`)
  2. System-action delivery tickets (`delivery-system-action-ticket.js`)
  3. Admin change sets (`admin-change-sets.js`)
  4. Agent-default skills state (`agent-default-skills-store.js`)
  5. Agent join registry (`agent-join-registry.js`)
  6. Agent graph + mutations (`agent-graph.js`, `agent-graph-mutations.js`)
  7. Graph loop registry (`graph-loop-registry.js`) and loop-round runtime (`loop-round-runtime.js`)
  8. Automation registry + runtime (`automation-registry.js`, `automation-runtime.js`)
  9. Schedule registry + materializer (`schedule-registry.js`, `schedule-materializer.js`)
  10. Delivery terminal artifacts (`delivery-terminal.js`) and runtime mailbox/outbox helpers (`runtime-mailbox-outbox-helpers.js`)
  11. Execution-contract entry ingress (`dispatch-execution-contract-entry.js`) and shared conversation store (`conversations.js`) where they write under `workspaces/controller`
- [ ] Use `control-plane-paths.js` as the single location authority. `state-paths.js` must stop hardcoding `workspaces/controller` and must derive from `control-plane-paths.js`; every consumer listed in this task's Files section reads its path from the new authority, never from a literal workspace string.
- [ ] Audit all matches for `workspaces/controller` / `workspaces", "controller"` across `extensions/watchdog/lib/**` before Task 8 exits. Any remaining reference outside the compat alias path is a blocker.
- [ ] Keep a temporary compatibility alias from `controller` to the split identities only while migration is in progress.
- [ ] Remove the old mixed `controller` identity after config, tests, reply targets, admin surfaces, and control-plane stores are migrated.
- [ ] Update existing regression tests that currently encode controller-rooted workspace truth so they stop asserting `workspaces/controller` paths. Named entry points (not exhaustive — see hard rule below): `tests/suite-agent-model.js:705`, `tests/suite-operator.js:1066`, `tests/suite-operator.js:1184`, `tests/review-harness-modules.test.js:79`, **plus shared test infra** `tests/infra.js:20`, `tests/runtime-store-stability.test.js:18`, `tests/contract-output-alias.test.js:16` and `:36`.
- [ ] **Hard rule:** every `workspaces/controller` path assumption anywhere under `.openclaw/extensions/watchdog/tests/**` (including shared helpers such as `tests/infra.js` and any suite-level bootstrap) must be migrated in Task 8. No test-side controller-rooted truth is allowed to outlive the controller alias.
- [ ] Do not reintroduce persona behavior into either managed runtime identity. If a personal assistant remains desirable, it must be a separate explicit agent.

**Formal Output Of Task 8**

- Loop state is execution-scoped, not mailbox-scoped.
- Tool-call hard-stop budget is formal policy, not a bare constant.
- WebUI bridge, platform operator, and control-plane stores are separate runtime truths.

**Task 8 Tests**

- [ ] A fresh `runId` gets a fresh loop state even on the same mailbox session key.
- [ ] Resume path preserves loop state intentionally.
- [ ] `executionPolicy.maxToolCalls` overrides the compat fallback.
- [ ] `max_tool_calls` hard-stop surfaces end-to-end.
- [ ] Finalize cleanup clears epoch-scoped loop state instead of only mailbox-scoped state.
- [ ] WebUI ingress still works after controller split.
- [ ] Operator surfaces still work after control-plane store migration.

**Task 8 Exit Gate**

- No active runtime path depends on bare global `MAX_TOOL_CALLS`.
- No root runtime truth still depends on the overloaded `controller` identity or its workspace path.
- Small-model failures can no longer poison future rounds by mailbox identity reuse.

---

## Verification Sequence

Run these after each task instead of batching all verification at the end:

1. Task 1
   - `node --test .openclaw/extensions/watchdog/tests/soul-template-builder.test.js`
   - `node --test .openclaw/extensions/watchdog/tests/guidance-drift.test.js`
   - `node --test .openclaw/extensions/watchdog/tests/agent-guidance-takeover.test.js`
   - verify `operator-snapshot` exposes drift counts, `emptySince`, and backup retention behavior

2. Task 2
   - `node --test .openclaw/extensions/watchdog/tests/loop-detection.test.js`
   - `node --test .openclaw/extensions/watchdog/tests/agent-end-graph-route.test.js`
   - `node --test .openclaw/extensions/watchdog/tests/after-tool-call-loop-warning.test.js`
   - verify operator snapshot attention includes recent hard-stop reasons

3. Task 3
   - `node --test .openclaw/extensions/watchdog/tests/system-action-role-policy.test.js`
   - `node --test .openclaw/extensions/watchdog/tests/bridge-system-action-boundary.test.js`

4. Task 4
   - bridge manual takeover of `controller`
   - bridge manual takeover of `kksl`
   - QQ manual message: simple reply
   - QQ manual message: delegated work
   - verify compat state counters
   - remove `[DISPATCH]` support and re-run the same QQ checks

5. Task 5
   - `node --test .openclaw/extensions/watchdog/tests/pending-signal-registry.test.js`
   - `node --test .openclaw/extensions/watchdog/tests/heartbeat-gate.test.js`
   - restart runtime and verify rehydrate restores direct-envelope and delivery signals

6. Task 6
   - `node --test .openclaw/extensions/watchdog/tests/runtime-wake-envelope.test.js`
   - `node --test .openclaw/extensions/watchdog/tests/runtime-wake-unification.test.js`
   - `node --test .openclaw/extensions/watchdog/tests/direct-vs-contract-session-semantics.test.js`

7. Task 7
   - startup sync no longer upgrades non-marker docs
   - takeover still works
   - drift state shows stable `emptySince`

8. Task 8
   - `node --test .openclaw/extensions/watchdog/tests/max-tool-calls-hard-stop.test.js`
   - `node --test .openclaw/extensions/watchdog/tests/execution-policy-max-tool-calls.test.js`
   - `node --test .openclaw/extensions/watchdog/tests/controller-split-migration.test.js`
   - Rerun existing regression tests that cover the epoch-key keyspace change and finalize cleanup:
     - `node --test .openclaw/extensions/watchdog/tests/loop-detection.test.js`
     - `node --test .openclaw/extensions/watchdog/tests/retry-suspend-runtime-lifecycle.test.js`
   - Grep audit (expanded to tests/**): `rg "workspaces/controller" .openclaw/extensions/watchdog/{lib,tests}` must return only explicitly documented compat alias locations. Any other hit in `lib/**` or `tests/**` (including shared test infra) fails the task.
   - manual ingress/operator verification after split and store migration

## Rollout Rules For Live System

- Do not migrate `kksl` before Task 4 dual parser introduction.
- Do not remove QQ `[DISPATCH]` until compat state proves post-cutover zero legacy usage.
- Do not remove gateway fallback before Task 5 producers, clear hooks, and boot rehydrate are all wired.
- Do not remove string wake fallback before Task 6 typed envelopes reach hooks, heartbeat fallback, and watchdog-owned consumers.
- Do not delete guidance legacy auto-upgrade before Task 1 drift evidence proves marker-managed stability and Task 4 live bridge migration is complete.
- Do not remove bare `MAX_TOOL_CALLS` before every configured agent has an effective `executionPolicy.maxToolCalls`.
- Do not remove `controller` alias before split identities and control-plane store paths are live.

## Explicit Non-Goals

- No attempt to make `qwen3.5:0.8b` pass immediately by prompt hacks.
- No new plugin-private protocol promoted to platform truth.
- No new startup overwrite heuristic for bridge or agent roles.
- No terminal-authority split away from `commitSemanticTerminalState`.

## Completion Criteria

This program is done only when all of the following are true:

- `controller` and `kksl` are managed bridge agents using formal runtime-owned coordination.
- QQ no longer parses `[DISPATCH]`.
- Gateway heartbeat actionability depends on pending signals, not unconditional gateway identity.
- Wake semantics are typed, and string matching no longer decides runtime semantics.
- Startup sync updates only marker-managed docs.
- Loop state is execution-scoped.
- Tool-call hard-stop budget is `executionPolicy.maxToolCalls`, not a bare constant.
- WebUI bridge, platform operator, and control-plane stores are no longer the same runtime identity.

## Pre-Implementation Ops Step

Before any code change for Task 1 begins:

1. Port every revision landed in this plan file into the canonical doc at `docs/superpowers/plans/2026-04-20-openclaw-system-truth-v5.1.md` so the on-disk authority matches this plan verbatim. As of this revision that canonical doc is behind on: state-paths.js migration, closed controller-store inventory, restart-persistence + reset-on-regression drift tests, existing-test reruns (loop-detection, retry-suspend-runtime-lifecycle), and the controller-rooted test suites that must be updated (suite-agent-model.js, suite-operator.js, review-harness-modules.test.js).
2. `git commit` the synchronized canonical doc with a message noting the v5→v5.1 closure patches.
3. `git push` (with `HTTPS_PROXY=http://127.0.0.1:8080` if needed) so the baseline is recoverable.
4. Only after the commit + push succeeds, start Task 1 implementation.

## Recommended Execution Strategy

- Implement Tasks 1 and 2 first.
- Review operator/harness visibility before beginning Task 3.
- Treat Tasks 3 through 6 as one continuous bridge/runtime-truth migration line. Do not stop on a half-formal layer.
- Treat Tasks 7 and 8 as mandatory closure, not optional cleanup.
