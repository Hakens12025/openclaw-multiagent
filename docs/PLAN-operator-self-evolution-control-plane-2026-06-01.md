<!-- 自动生成草案 (workflow operator-control-plane-design, 2026-06-01)。状态: 待用户审批后实施。基于代码调研,引用 file:line。 -->

> 🛑 **历史文档 · 部分引用已失效（2026-08-18 回路退役后标注）**
> 本文成文时控制面结构真值是 **4 份**，其中第 2 份 Loop registry 已随回路整体退役删除：
> `graph-loop-registry.js` / `loadGraphLoopRegistry` / `saveGraphLoopRegistry` / `control-plane/graph-loop-registry.json` /
> `suite-loop-direct.js` / `graph.loop.compose` / `runtime.loop.interrupt|resume` / `composeLoopSpecFromAgents` —— **全部不存在**。
> 现行真值为 **3 份**：graph / agent bindings(config) / automation specs；写入顺序相应收为
> bindings(`saveConfig`) → graph(`saveGraph`) → automations(`writeAutomationStore`)。
> 当前实现以 `lib/control-plane/structure-snapshot.js` 为准，本文仅作设计意图与取舍的历史记录。
>
> **2026-08 补注**：本文引用的旧 dashboard 前端族（`dashboard-devtools` / `dashboard-control-plane` 等 dashboard-* 页面脚本）
> 已随 v233 前端重制整删，现前端 = `extensions/watchdog/ui/` 零构建 SPA。正文中的 dashboard-* 名称与行号均为当时快照，
> 下文一律以不带扩展名的模块名书写。`admin-change-set-history.js` 现址 = `lib/admin/change-sets/admin-change-set-history.js`。

# ⑤ Operator Self-Evolution Control Plane — Design Doc Draft

**Status:** draft for review · **Scope:** new admin subpage + 1 new module (structure-snapshot) + minimal endpoints · **Hard rules honored:** one path (reuse change-set/operator/surface machinery), contract=single-truth, no god objects, no legacy, surgical.

**Concept budget:** This adds **exactly 1 net-new concept: the Structure Snapshot ("snapshot code").** Everything else (proposals, diff/preview, commit gate, verification, tiers, operator output) maps onto existing concepts. Flagged in §7. The snapshot is unavoidable — rollback is impossible without a captured prior state, and finding #3 confirms no such capture-and-restore primitive exists today.

> **Material correction to the findings:** Finding #3 gap (1) says "MUST BUILD atomic write wrapper for openclaw.json." **This is wrong.** `saveConfig(config)` already exists at `agent-admin-store.js:95-105` — it does `atomicWriteFile(openclaw.json)` + `invalidateConfigCache()` + `registerRuntimeAgents()` + `syncDispatchTargetsFromRuntime()` + `persistDispatchRuntimeState()` + `invalidateCapabilityRegistryCache()`, all under the lock key `agent-admin:write` (line 107). Binding-truth restore **reuses `saveConfig` verbatim**; we build no new config writer. This is the single most important reuse in the whole design.

---

## 1. Reuse map

| Control-plane part | Reuses (existing) | Cite |
|---|---|---|
| **Right panel — proposals are change-set drafts** | `saveAdminChangeSetDraft()` creates/updates a draft per proposal; `decorateDraft()` returns full shape incl. `riskLevel`, `confirmation`, `operatorPhase`, history. Proposal = `ACS-*` draft. No new proposal store. | `admin-change-sets.js:231-256`, `:62-90` |
| **Right panel — diff** | `buildAdminChangeSetPreview()` / `previewAdminChangeSetExecution()` return `{request:{method,path,payload}, inputFields, missingFields, ready}` (read-only, no write). This is the raw diff source. | `admin-change-set-preview.js:10-54`, `admin-change-set-executor.js:17-28` |
| **Right panel — apply / commit gate** | `executeAdminChangeSet({id, dryRun, explicitConfirm, startVerification, requireVerification})` is the SOLE apply entry. Confirmation gating (`:44-46`), commit-verification gate (`:101-120`, throws `CommitVerificationBlockedError`), applied/blocked status all already enforced. | `admin-change-set-executor.js:30-202` |
| **Right panel — verify** | `evaluateCommitVerificationGate()` is sole arbiter `{required, passed, reason, failedCaseIds, blockedCaseIds}`; `attachAdminChangeSetVerification()` merges test-run into `verificationHistory`. UI **reads & displays** the gate, never re-implements it. | `admin-change-set-commit-gate.js:28-58`, `admin-change-sets.js:258-292` |
| **Left panel — operator review results** | Operator snapshot already loads operator/loop/draft context + `loadSnapshotCoreData()` reads graph/loops/automations via inspect surfaces. Fetched via `/watchdog/operator-snapshot` (the dashboard already calls this). EvaluationResult / run reports surface through the operator's existing output. | `operator-snapshot.js:83`; dashboard `dashboard-devtools:1316,1724` |
| **Tiering — danger ranking** | `surface.risk` (+ `confirmation`, `operatorPhase`) copied onto draft as `riskLevel`/`confirmation` at save time. 6 declared levels: read/observe/runtime_gate/safe/structural/destructive. No secondary `isStructural` flag — structural = `risk:"structural"`. | `admin-change-sets.js` (riskLevel copy), catalog `apply-rest.js:267-360`, `agents-apply.js:191-211` |
| **Rollback (NEW, but reuses writers)** | Restore re-writes the 4 truths via existing writers: `saveGraph` (`agent-graph-mutations.js:34`), `saveGraphLoopRegistry` (`graph-loop-registry.js:123`), `writeAutomationStore` (`automation-registry.js:180`), **`saveConfig`** (`agent-admin-store.js:95`). Atomic infra: `atomicWriteFile`/`withLock` (`state-file-utils.js:13,121`). Restore proven by test pattern `suite-loop-direct.js:93-102`. | as cited |
| **Page shell / nav / token / requestJson / confirm** | New tab inside existing `/watchdog/devtools` as a 4th `VIEW_MODES` entry; `createControlPlaneView` factory `{renderActions,renderSummary,renderHistory}`; `tokenParam()`+`requestJson()`; native `confirm()`. | `dashboard-devtools:3-7,1784-1805,88-104` |

**Gap-driven new builds (flagged from findings):** rollback/restore primitive (finding #2 gap 1), structure snapshot capture/store (finding #3 gaps 2-5), revert status values (finding #2 gap 3), tiering function (finding #4 gap 1), double-confirm gate for structural (finding #4 gap 2), control-plane routes (finding #5 gap 1). **NOT a gap (finding wrong):** openclaw.json atomic writer.

---

## 2. Structure Snapshot Code — the core new build

New module: `lib/control-plane/structure-snapshot.js` (single-purpose, ~120 lines — under god-object limit). Owns capture + restore + verify of the 4 structural truths. It is the **rollback foundation**: every other piece depends on it existing first.

### 2.1 What it captures (the 4 truths + exact source files)

| # | Truth | File | Read fn | Write fn (restore) |
|---|---|---|---|---|
| 1 | Graph edges | `control-plane/agent-graph.json` | `loadGraph()` `agent-graph.js:60` | `saveGraph(graph)` `agent-graph-mutations.js:34` |
| 2 | Loop registry | `control-plane/graph-loop-registry.json` | `loadGraphLoopRegistry()` `graph-loop-registry.js:109` | `saveGraphLoopRegistry(reg)` `:123` |
| 3 | Agent bindings (skills/capabilities/policies) | `openclaw.json` → `agents.list[].binding` | `loadConfig()` `agent-admin-store.js:70` | **`saveConfig(config)`** `:95` |
| 4 | Automation specs | `control-plane/automation-registry.json` | `listAutomationSpecs()` `automation-registry.js:195` | `writeAutomationStore(autos)` `:180` |

Truth #3 captures the **whole `openclaw.json`** content, not just the binding subtree — `saveConfig` expects a full config object and re-runs normalization/runtime-sync. Storing the full config is the only way restore stays a one-liner `saveConfig(snapshot.config)`. (Secrets concern → §7.)

### 2.2 Format: **content-addressed hash + full store** (recommended)

Store **full content** of all 4 truths in a single registry file, each snapshot tagged with a `contentHash` (sha256 over canonical-JSON of the 4 truths). Rationale:

- **Full content (not hash-only):** rollback must *re-write* the truths; a hash alone cannot reconstruct them. Finding #3 gap 4 wants a hash for *integrity check*, not as the storage format. We do both: full content for restore, hash for "did the live state drift since capture?" verification before restore.
- **Single registry file (Option B from finding #3 gap 5):** follows the established `automation-registry.json` pattern (`{updatedAt, snapshots:[...]}`), reuses `atomicWriteFile`+`withLock`, keeps it 0-dep, easy to prune (keep last N). Avoids a directory-of-files (Option A) which needs its own GC/listing logic.
- These 4 JSON truths are small (edges, loop specs, agent list, automation specs) — full-copy cost is negligible. Content-addressed *dedup* (store body once keyed by hash, snapshots reference it) is a future optimization, NOT v1 (flagged §7).

**Persist at:** `control-plane/structure-snapshots.json`. Add to `CONTROL_PLANE_PATHS` as `structureSnapshotsFile` (`control-plane-paths.js:16-36`) — one new frozen path entry, mirrors existing entries.

**Snapshot record shape:**
```
{ id, label, contentHash, capturedAt, reason, sourceDraftId?,
  truths: { graph, loopRegistry, config, automations } }
```

### 2.3 Capture API + Restore API

```
// capture: read all 4 → hash → prepend to registry (cap last N, e.g. 20) → atomicWrite
async function captureStructureSnapshot({label, reason, sourceDraftId} = {})
  → returns { id, contentHash, capturedAt }

// restore: load snapshot by id → re-write 4 truths via EXISTING writers → return diff vs pre-restore
async function restoreStructureSnapshot(snapshotId, { expectHash } = {})
  → { ok, restored:{graph,loops,automations,bindings}, drift? }

// integrity / pre-flight diff (read-only)
async function verifyAgainstSnapshot(snapshotId)
  → { liveHash, snapshotHash, drifted: bool, diffs:{...} }
```

### 2.4 Atomicity

The 4 writers each own a *different* lock (`agent-graph`, `graph-loop-registry`, `store:automation-specs`, `agent-admin:write`). True cross-file 2-phase atomicity is not available and **not worth building** (no XA primitive, 0-dep). Pragmatic guarantee instead:

- **Capture** takes all 4 reads inside one outer `withLock("control-plane:structure-snapshot", ...)` so it can't interleave with another capture/restore.
- **Restore** runs under the same outer lock, then writes in a **documented fixed order: bindings(`saveConfig`) → graph(`saveGraph`) → loops(`saveGraphLoopRegistry`) → automations(`writeAutomationStore`)**. Each inner writer is itself atomic+locked, so no file is ever half-written.
- After all 4 writes, `verifyAgainstSnapshot()` runs and compares live `contentHash` to the snapshot's. If mismatch (partial-failure / concurrent mutation), restore returns `{ok:false, drift}` and the UI surfaces it as a failed restore for the human to re-run. **No silent partial success.**
- `expectHash` guards against TOCTOU: caller passes the hash it showed the human; if live state changed between preview and confirm, restore aborts.

### 2.5 What is NOT captured (explicit)

- Runtime sessions, loop-session state, dispatch chain, inbox/outbox queues, in-flight contracts — these are *runtime*, owned by `state-persistence.js`, **out of scope**. A structure rollback resets topology/bindings/automations, NOT live work. (Document this clearly in UI: "rolling back structure does not abort running agents.")
- Test reports, change-set drafts, conversations, output artifacts.
- The snapshot is **structure only** — exactly the 4 truths.

### 2.6 How rollback maps to re-writing the 4 truths

Rollback = `restoreStructureSnapshot(id)` = call the 4 existing write functions with the captured bodies, in fixed order, under outer lock, then verify hash. There is **no inverse-operation / undo-log** approach (finding #2 gap 1 asked which) — we chose **restore-from-saved-state**, because "re-execute opposite payload" is impossible to derive generally for structural changes (e.g., a `graph.loop.compose` has no clean inverse). Saved-state restore is the only correct general mechanism, and `suite-loop-direct.js:93-102` already proves the save→mutate→restore cycle works for graph+loops.

### 2.7 How a "code" identifies a snapshot

`id` scheme mirrors existing ID conventions (`ACS-`, `ACE-`, `ACV-`): **`SNAP-${capturedAt}-${shortHash}`** where `shortHash` = first 8 chars of `contentHash`. Human-friendly, sortable, and the embedded hash makes the code self-describing ("this code IS that structure"). This `SNAP-…` string is the "structure snapshot code" the user asked for — shown in the UI, copy-able, and is the rollback handle.

---

## 3. Danger tiering

Pure function `evaluateProposalTier(surface|draft)` in a new tiny `lib/control-plane/proposal-tier.js` (finding #4 gap 1). Reads **only** existing fields `risk` + `confirmation` (+ `operatorPhase` for display). No new surface flags.

| Tier | Source fields | UI | Gate |
|---|---|---|---|
| **T1 SAFE** | `risk ∈ {read, safe}` & `confirmation ∈ {none, changeset}` | green/neutral | standard change-set (preview → optional verify → apply) |
| **T2 GUARDED** | `risk:"safe"` & `confirmation:"explicit"` (e.g. `schedules.delete`) | amber | preview + explicit single confirm |
| **T3 STRUCTURAL** | `risk:"structural"` (graph.loop.compose/repair, runtime.loop.interrupt/resume) | orange | **double-confirm (two clicks)** + auto-capture snapshot before apply |
| **T4 DESTRUCTIVE** | `risk:"destructive"` (agents.delete/hard_delete, automations.delete, agent_joins.delete, runtime.reset) | red | **double-confirm** + typed acknowledgement + auto-capture snapshot |

- **Double-confirm trigger:** any tier ≥ T3 (`risk` is `structural` or `destructive`). This is the user's "structural changes get the strictest gate, two clicks" requirement.
- **Structural-ness derivation:** **static, from `risk:"structural"`** — finding #4 confirms these 5 surfaces are the *only* ones carrying it, and no `isStructural` flag exists. We do NOT attempt dynamic payload analysis (finding #4 gap 5: "will this edge create a cycle?") in v1 — flagged §7 as future. Static risk field is the contract single-truth.
- **Enforcement, not just display:** the existing commit gate already blocks unverified applies. The **new** piece is the UI-side double-confirm for T3/T4 + auto-snapshot-before-apply (see §4). We do **not** add a server-side "structural needs N signatures" gate in v1 unless §7 says so — the double-click + mandatory pre-apply snapshot is the safety mechanism, and rollback is always available.

---

## 4. Page layout + data flow

**Lives inside `/watchdog/devtools` as `VIEW_MODES.CONTROL_PLANE` (4th tab).** No new HTML page, no new route registration for the page itself — add to `VIEW_MODES` (`dashboard-devtools:3-7`), `renderViewTabs()` (`:1810-1823`), `getActiveView()` (`:1801-1805`), and inject the `dashboard-control-plane` script (`/watchdog/dashboard-control-plane` 路径) in `devtools.html` before the `dashboard-devtools` script. Factory `createControlPlaneView(app) → {renderActions, renderSummary, renderHistory}` exactly like `createManagementView`.

```
┌─ CONTROL PLANE tab ─────────────────────────────────────────────┐
│ renderActions(): snapshot bar — [Capture snapshot] [Rollback ▾]  │
│                  current structure code: SNAP-…  (live hash dot) │
├──────────────────────────┬──────────────────────────────────────┤
│ LEFT  renderSummary()    │ RIGHT  renderHistory()                │
│ OPERATOR REVIEW          │ PROPOSED CHANGES (tiered)             │
│ • run reports /          │  T1 ▸ … (green)                       │
│   EvaluationResult        │  T2 ▸ … (amber)                       │
│ • attention queue         │  T3 ▸ graph.loop.compose (orange) ⚠  │
│ • why each proposal       │  T4 ▸ runtime.reset (red) ⚠⚠        │
│ from /operator-snapshot   │  each row → [Diff] [Verify] [Apply]  │
└──────────────────────────┴──────────────────────────────────────┘
```

- **LEFT reads:** `/watchdog/operator-snapshot` (already exists; `dashboard-devtools:1316`). Renders operator's consumed run reports / EvaluationResult + attention queue + the rationale tying a review to its proposal (`sourceDraftId` linkage). Read-only.
- **RIGHT reads:** `GET /watchdog/admin-change-sets` (lists drafts = proposals) → group/sort by `evaluateProposalTier()`. Each row's diff via `GET /watchdog/admin-change-sets/preview?id=X` (`routes/admin-change-sets.js:109-117`). Verify status via the draft's `verificationHistory` + gate eval (already on `decorateDraft`).
- **Apply → verify → rollback flow (all reuse change-sets):**
  1. **Diff:** preview endpoint, read-only. Show `request.method path` + payload + `missingFields`.
  2. **Verify:** `POST /watchdog/admin-change-sets/execute` with `dryRun:true` then attach test-run via existing verification route, OR `startVerification:true` on real apply. Gate shown from `evaluateCommitVerificationGate`.
  3. **Apply:** `POST …/execute` `{dryRun:false, explicitConfirm:true, requireVerification:true}`. For **T3/T4**, the control-plane apply wrapper first calls `captureStructureSnapshot({reason:"pre-apply", sourceDraftId})`, **then** executes. The returned `SNAP-…` code is stored on the execution record so the row shows "rollback to SNAP-… (state before this apply)".
  4. **Rollback:** `POST /watchdog/control-plane/rollback {snapshotId, expectHash}` → `restoreStructureSnapshot`. Reversible by design.
- **Double-confirm UX (T3/T4):** first click → row expands inline to a confirm strip ("This is a STRUCTURAL change. A snapshot SNAP-… will be captured first. Apply?") with a second **APPLY** button. Two distinct clicks, no auto-fire. T4 adds a typed token (e.g. type the surfaceId) before the second button enables — reuses native pattern (`dashboard-devtools:1442` confirm style), no modal lib.
- **NASA-Punk flat:** inherit `dashboard-devtools.css`; new classes `.cp-tier-row`, `.cp-tier-{1..4}` (left-border color = tier, per the v116 "status-driven left border" convention, NOT badges/glows), `.cp-snapshot-bar`. Zero radius/shadow/gradient. Tier color is a left border + label, consistent with the agents-page refactor.
- **Refresh:** new `refreshControlPlane()` re-fetches `/operator-snapshot` + `/admin-change-sets` after any apply/rollback, then `renderDevtools()` (finding #4 gap 6). Reuses existing `requestJson`/render dispatch.

---

## 5. New endpoints/surfaces needed (minimal)

Only **2** new HTTP routes + **0 new admin surfaces** + **1 new path entry**. Snapshot capture-before-apply happens server-side inside the control-plane rollback route's sibling helper, not as a user-facing surface.

| New endpoint | Why existing doesn't suffice |
|---|---|
| `POST /watchdog/control-plane/snapshot` → `captureStructureSnapshot()`, also `GET` to list snapshots | No existing route captures/persists the 4 truths as a restorable bundle. `operator-snapshot.js` is read-only inspection, no persistence/restore (finding #3). |
| `POST /watchdog/control-plane/rollback {snapshotId, expectHash}` → `restoreStructureSnapshot()` | No revert/undo exists anywhere (finding #2 gap 1). Cannot be a change-set surface because it re-writes 4 files at once via 4 different writers; it's a control-plane composite operation, not a single templated surface. |

What we **do not** add and why: no new page route (4th tab in devtools). No new apply surface (apply reuses `executeAdminChangeSet`). No new openclaw.json writer (reuse `saveConfig`). No new verify path (reuse commit gate). Pre-apply auto-snapshot is internal to the control-plane apply handler, not a separate endpoint.

One config addition: `structureSnapshotsFile` in `CONTROL_PLANE_PATHS` (`control-plane-paths.js:16-36`).

**New draft statuses** (finding #2 gap 3): extend `resolveDraftStatus()` (`admin-change-set-history.js:115-143`) with `"reverted"` / `"revert_failed"` so an applied-then-rolled-back proposal reads truthfully. Surgical, additive.

---

## 6. Build phases (each gate-able + revertable, snapshot first)

1. **Phase 0 — Structure Snapshot module (foundation).** `lib/control-plane/structure-snapshot.js` (capture/restore/verify) + `CONTROL_PLANE_PATHS.structureSnapshotsFile` + reuse `saveConfig`/`saveGraph`/`saveGraphLoopRegistry`/`writeAutomationStore`. Unit-test capture→mutate→restore→verify round-trip (model on `suite-loop-direct.js:93-102`). **Gate:** round-trip restores all 4 truths, hash matches. Ships standalone, usable from CLI before any UI.
2. **Phase 1 — Control-plane routes.** `routes/control-plane.js`: `snapshot` (POST/GET) + `rollback` (POST). Token auth like admin-change-sets routes. **Gate:** can capture and rollback via HTTP, verified by test-runner, no UI yet.
3. **Phase 2 — Tier function + status extension.** `proposal-tier.js` + `resolveDraftStatus` `reverted` states. Pure functions, unit-tested against the 5 structural + 5 destructive surfaces. **Gate:** correct tier for every catalog surface.
4. **Phase 3 — Control-plane view (UI).** `dashboard-control-plane` 视图 factory + `VIEW_MODES.CONTROL_PLANE` tab + left (operator-snapshot) / right (tiered drafts + diff/verify/apply). Reuse `requestJson`/`tokenParam`. **Gate:** headless-Chrome screenshot per the v116 method; renders both panels.
5. **Phase 4 — Double-confirm + auto-snapshot-on-apply wiring.** T3/T4 two-click + typed ack; control-plane apply handler captures snapshot before `executeAdminChangeSet` and stamps `SNAP-…` on the execution record; rollback button per applied structural/destructive row. **Gate:** structural apply captures a snapshot and is rollback-able end-to-end.

Each phase is independently revertable (delete the module/route/tab; no edits to existing apply path semantics — all additive).

---

## 7. Risks / open questions for the user

1. **Snapshot storage: full-copy vs content-addressed.** Recommending **full-copy in a single registry, hash for integrity** (v1), with content-addressed dedup as a *later* optimization. Confirm you don't want content-addressed dedup from day one. Also: **retention** — keep last N (propose 20) + every pre-T3/T4-apply snapshot? Or keep all forever?
2. **`openclaw.json` contains secrets** (per project CLAUDE.md §8). Truth #3 stores the **whole config** to reuse `saveConfig`. The snapshot registry will therefore contain API keys. **Decision needed:** (a) accept it (file lives under `~/.openclaw/control-plane/`, same trust zone as `openclaw.json` itself — lowest-friction, recommended), or (b) snapshot only `agents.list` and write a partial-merge restore (more code, weaker reuse of `saveConfig`). I recommend (a) — it keeps the one-path/single-writer guarantee.
3. **Operator proposal generation: continuous vs on-demand.** Does the operator auto-emit proposals (drafts) continuously from run reports/EvaluationResult, or only when the human clicks "generate"? Findings show operator *produces plans* but the cadence isn't wired. Recommend **on-demand for v1** (human pulls), continuous later — avoids a flood of unreviewed T3/T4 drafts.
4. **Concept budget.** We add **1 net-new concept (Structure Snapshot / SNAP-code)** — within the ≤11 ceiling, and it's load-bearing (rollback is impossible without it). Everything else maps onto existing change-set/surface/operator concepts. Confirm this single addition is acceptable.
5. **Structural-ness is static** (from `risk:"structural"`). Dynamic payload analysis ("does this `graph.edge.add` create a cycle → escalate tier") is **deferred** (finding #4 gap 5). Confirm static tiering is acceptable for v1.
6. **Server-side structural double-signature?** v1 relies on UI double-click + mandatory pre-apply snapshot + the existing verification commit gate. We are **not** adding a server-enforced "structural requires explicit second token" beyond the existing `confirmation` field. Confirm UI-side double-confirm + always-available rollback is sufficient, or whether you want a hard server gate too.

---

**Files an engineer touches** (all absolute):
- NEW `/Users/hakens/.openclaw/extensions/watchdog/lib/control-plane/structure-snapshot.js`
- NEW `/Users/hakens/.openclaw/extensions/watchdog/lib/control-plane/proposal-tier.js`
- NEW `/Users/hakens/.openclaw/extensions/watchdog/routes/control-plane.js`
- NEW `dashboard-control-plane` 页面脚本（当时位于扩展根；该 dashboard 族已随 v233 整删）
- EDIT `/Users/hakens/.openclaw/extensions/watchdog/lib/control-plane/control-plane-paths.js` (add `structureSnapshotsFile`)
- EDIT `/Users/hakens/.openclaw/extensions/watchdog/lib/admin/change-sets/admin-change-set-history.js` (add `reverted`/`revert_failed` to `resolveDraftStatus`, ~:115-143；成文时位于 `lib/admin/` 根)
- EDIT `dashboard-devtools` 页面脚本 (`VIEW_MODES`, `renderViewTabs`, `getActiveView`；该 dashboard 族已随 v233 整删)
- EDIT `/Users/hakens/.openclaw/extensions/watchdog/devtools.html` (script inject)

**Reuse-verbatim (do NOT modify):** `saveConfig` (`agent-admin-store.js:95`), `saveGraph` (`agent-graph-mutations.js:34`), `saveGraphLoopRegistry` (`graph-loop-registry.js:123`), `writeAutomationStore` (`automation-registry.js:180`), `executeAdminChangeSet` (`admin-change-set-executor.js:30`), `evaluateCommitVerificationGate` (`admin-change-set-commit-gate.js:28`), `atomicWriteFile`/`withLock` (`state-file-utils.js:13,121`).
---

## 8. 用户审批决策 + 设计细化 (2026-06-01,已批准开建)

**审批结论:批准,按阶段建。** 开放问题定案:

1. **快照存全 config**(§7 Q2 选 a):快照存整个 openclaw.json,回滚 = `saveConfig(snapshot.config)` 一行。接受快照文件含密钥(同 `~/.openclaw/control-plane/` 信任区)。保单一 writer/一条路径。
2. **概念预算 +1 / 静态分级 / 无服务端双签**:全部确认推荐默认(§7 Q4/Q5/Q6)。
3. **提案生成 = 持续自动 + 去重**(§7 Q3 改为 continuous + dedup):operator 持续从 run reports/EvaluationResult 出提案,**但生成前先扫描现有未决提案,命中相同 surfaceId+payload 指纹则不重复创建**(避免多重存在)。去重键 = `surfaceId + 规范化 payload hash`,落在 `saveAdminChangeSetDraft` 入口前做幂等检查。

### 8.1 提案展示 + 「改完变成什么样」(UI 细化)

右侧每条提案行除 diff(request/payload)外,显示**人类可读的「改后状态描述」**:这条改动落地后系统/agent 会变成什么(如「researcher1→worker-e 之间新增一条授权边」「reviewer1 的 maxRounds 由 4 改为 6」)。由 `proposal-tier.js` 旁的 `describeProposalEffect(surfaceId, payload)` 生成(纯函数,按 surface 类型出一句话效果描述)。

### 8.2 预览按钮 = 反向用结构快照码(新增能力,核心细化)

**用户洞察**:既然有结构快照码能存/还原结构,就能**反向用它做投影预览** —— 点提案的「预览」按钮,看到「若采纳此提案,结构会变成什么样」,直观看 agent 设计/系统架构变化。

**设计**:`structure-snapshot.js` 增 `projectStructureAfter({surfaceId, payload})`(纯投影,**不落盘、不触发 runtime**):
- 读当前 4 真值(同 capture 的读路径)→ 在**内存副本**上施加该 surface 的结构效果(复用 apply 用的纯函数:如 graph.loop.compose 复用 `composeLoopSpecFromAgents`+边构建逻辑,agents.* 改 binding 字段)→ 得「投影后 4 真值」。
- 返回 `{ current, projected, diff }`,diff 按真值分组(新增/删除/变更的边、loop、binding、automation)。
- UI 预览 = 当前结构缩略图 ⟶ 投影结构缩略图(复用工作流页拓扑渲染),高亮变化部分。**非破坏性**(纯计算,绝不动 live)。
- **与 apply-capture-rollback 的取舍**:不采用「真 apply 再回滚」做预览(会真动 live + 触发 runtime + 跑 verify 门,风险高);采用**纯内存投影**(安全、即时)。代价:每类 surface 要有投影逻辑——v1 先覆盖结构类 surface(graph 边/loop、agent role/binding),其余 surface 预览降级为「仅 payload diff,无结构投影」并标注。

**新增 phase**:Phase 2.5 — `projectStructureAfter` + `describeProposalEffect`(纯函数,可单测投影正确性);UI 预览在 Phase 3 接入(复用 dashboard-workflow 拓扑渲染画「投影后」图)。

### 8.3 去重落点(Phase 1/operator 侧)

operator 持续生成提案时,在创建 draft 前调用幂等检查:扫 `listAdminChangeSetDrafts()` 中未 applied/未 reverted 的草稿,若存在相同 `dedupeKey(surfaceId,payload)` 则跳过(或更新 updatedAt 而非新建)。`dedupeKey` 为纯函数,放 `proposal-tier.js` 同目录。

---

## 9. 结构分享码 + 安全模型 (2026-06-01,用户细化 + 批准)

**两层架构**(用户定):
- **本地回滚快照**(`structure-snapshot.js`,已建 Phase 0):全量含密钥,存 `control-plane/structure-snapshots.json`,专管回滚(高保真),不外传。
- **结构分享码**(`structure-share-code.js`,新):分级、自包含压缩码、可离线导入到另一台机器复现。

**分享码格式**:`OCS-v1-<L>-<base64url(deflateSync(规范化JSON))>`,内嵌 8 位 contentHash(身份+完整性)。Node 内置 `zlib`,0 依赖。L1 拓扑码很短。

**3 级继承 + 安全裁定(核心:base64+deflate=编码非加密,谁都能解)**:

| 级别 | 码 | 含 | 不含 | 社区传播 | 护栏 |
|---|---|---|---|---|---|
| **L1 结构** | `OCS-v1-S-…` | graph 边/loop specs/agent 名册{id,role,工具名,技能名,binding 策略}/automation specs | agent 正文、密钥 | ✅ 安全 | 导出前密钥扫描兜底 |
| **L2 结构+内容** | `OCS-v1-SC-…` | L1 + agent 正文(SOUL/IDENTITY/role-spec/skill 全文) | api key/provider | ⚠️ 需扫描 | **强制密钥扫描,命中即拦**(防正文夹带) |
| **L3 全+api** | `OCS-v1-SCA-…` | L2 + providers/api 密钥(**明文**) | — | ❌ 禁止分享 | UI 仅「个人备份」入口+红字警告,不给分享;可选口令加密(future) |

**安全护栏(焊死)**:
1. UI「分享」只暴露 L1/L2;L3 独立「个人完整备份」入口,标注含密钥勿外传。
2. `scanForSecrets(payload, liveSecrets)`:用 live config 真实密钥值 + 通用 key 正则(sk-/长 hex/token)扫描;L1/L2 命中即**拦截导出**;L3 跳过扫描但标 `containsSecrets:true`。
3. L3 默认明文本地(同 openclaw.json 信任区);口令加密(AES via node:crypto)列为 future。
4. contentHash = 完整性校验(防篡改),非保密。

**新模块**:`lib/control-plane/structure-share-code.js`(export/import + 3 级 scoping + secret-scan)。L2/L3 需读 agent 正文(workspaces/<id>/SOUL.md 等 + skills/)——capture 范围扩展,作为该模块的 phase(L1 先建稳,L2/L3 随后)。

### 9.1 高效压缩:几 KB 复现「结构+内容」(用户要求)

目标:L2 码几 KB 即可广泛传播复现。三招(全 0 依赖):

1. **Brotli 替代 deflate**:`zlib.brotliCompressSync`/`brotliDecompressSync`(node 内置),文本压缩比 deflate 好 ~15-25%,自带文本字典。码格式改 `OCS-v1-<L>-<base64url(brotli(minifiedCanonicalJSON))>`。
2. **builtin 按名引用,不嵌正文**(关键):平台标配 skill/模板(platform-map/platform-tools/error-avoidance/system-action…)只存 `{name, version, contentHash}`,**不嵌 body**——社区共享同一 OpenClaw 底座,导入端本地有这些 builtin。**只嵌自定义 delta**(改过的 SOUL/role-spec/自定义 skill body)。这是"社区传播 + 几 KB"成立的核心。
3. **共享内容去重 + minify**:多 agent 引用同一 body 只存一份(按 contentHash 去重,引用指向);JSON 去空白后再压。

**导入端解析**:builtin 引用 → 本地按 name+version 解析;若 hash 不匹配/缺失 → 警告"缺 skill X,请安装或用更完整的码"(自定义内容始终内嵌,不会缺)。

**尺寸预期**:L1 <1KB;L2 典型 1-5KB;仅当含大块自定义 skill 正文才涨,UI 标注码体积 + 主要占用来源,让用户知情。

**实测验证**:share-code 模块要带 `estimateCodeSize()` + 单测断言典型 L1/L2 码 < 目标阈值(如 L1<1KB、L2<8KB at 标准配置)。

### 9.2 Phase 1 实测(structure-share-code.js,已建)

模块 `lib/control-plane/structure-share-code.js`:`exportStructureCode`/`decodeStructureCode`/`estimateCodeSize`/`scanForSecrets`。码格式 `OCS-v1-<L>-<hash8>-<base64url(brotli(minCanonicalJSON))>`。

**实测尺寸(当前 5-agent 配置)**:
- L1 结构: **0.6 KB**(raw 3.1KB,brotli 4.9x)
- L2 结构+内容: **6.4 KB**(raw 28.2KB,4.4x)—— 5 agent SOUL 全文 + 拓扑 + 名册,4 builtin skill 按名引用不嵌 → 达成"几 KB 复现结构+内容"
- L3 全+api: 8.3 KB(含密钥,shareable=false)

builtin skill 集 = {platform-map, platform-tools, error-avoidance, system-action}(平台基线,按名引用);自定义 skill 才嵌正文。安全:L1/L2 导出前 `scanForSecrets`(live 密钥值 + 通用 key 正则)命中即拦;L3 跳过扫描标 containsSecrets。测试 6/6。
