// lib/formal-runtime/error-codes.js — 检查错误码注册表（单一真值源）
//
// 约定：
// - 码格式 E-<SUBSYS>-<NNN> 或 E-<SUBSYS>-SKIP（skip 前置条件码）。
// - 每个 fail/blocked/skip 状态的 CheckResult 必须引用这里注册的码（check-runner 在 add 时校验）。
// - hint 必须指名具体文件 / 路由 / 真值源——让读报告的 agent 不看进程也能定位。
// - 数据用英文（报告面向 agent 消费），注释用中文（仓库风格）。

function entry(subsystem, meaning, hint) {
  return Object.freeze({ subsystem, meaning, hint });
}

export const ERROR_CODES = Object.freeze({
  // ── gateway / auth ──────────────────────────────────────────────────────────
  "E-GW-001": entry("gateway", "gateway unreachable (refused/timeout on port 18789)", "start via `bash ~/.openclaw/start.sh` (or `openclaw gateway run`); confirm /tmp/openclaw-gateway.log contains '===== WATCHDOG V3 MODULAR FULLY INITIALIZED =====' (emitted by index.js gateway_start)"),
  "E-GW-002": entry("gateway", "request with the configured token was rejected (401)", "token mismatch: compare the client token with gateway.auth.token in ~/.openclaw/openclaw.json; auth guard lives in routes/api.js (~L36-42)"),
  "E-GW-003": entry("gateway", "request WITHOUT token was accepted (expected 401)", "auth gate hole: the token guard in routes/api.js (~L36-42) must cover every /watchdog/* route; treat as a security regression"),
  "E-GW-004": entry("gateway", "boot marker missing from gateway log", "gateway_start hook did not complete: grep /tmp/openclaw-gateway.log for stack traces; the marker is written at the end of full init in index.js"),
  "E-GW-005": entry("gateway", "GET /watchdog/runtime payload malformed", "expected {trackingSessions,dispatchQueue,dispatchRuntime,...} built in routes/api.js (~L253-285); a missing field usually means a runtime-state refactor broke the projection"),

  // ── inspect 家族 ─────────────────────────────────────────────────────────────
  "E-INSPECT-001": entry("inspect", "inspect surface returned non-200 or invalid JSON", "GET /watchdog/inspect?surface=<id> (routes/api.js ~L187-220); data sources are INSPECT_SOURCES in lib/cli-system/cli-surface-inspector.js (~L55-151)"),
  "E-INSPECT-002": entry("inspect", "unknown or non-inspect surface id was NOT rejected with 403", "the inspect route must only serve family==='inspect' surfaces registered in lib/cli-system/cli-surface-registry.js; check the family gate in routes/api.js"),
  "E-INSPECT-003": entry("inspect", "inspect payload missing a required field", "compare the payload with its data source in lib/cli-system/cli-surface-inspector.js; field renames must migrate consumers (dashboard, CLI poller, operator snapshot)"),
  "E-INSPECT-004": entry("inspect", "surface registry counts drifted from the expected snapshot", "summarizeCliSystemSurfaces() in lib/cli-system/cli-surface-registry.js; if surfaces were intentionally added/removed, update the check's expected byFamily counts"),
  "E-INSPECT-005": entry("inspect", "admin-sourced inspect id behavior changed (expected 'no data source' error)", "only the ids in INSPECT_SOURCES have data sources; admin-sourced inspect-family ids (e.g. agents.list) pass the family check but must error (lib/cli-system/cli-surface-inspector.js)"),
  "E-INSPECT-006": entry("inspect", "path traversal in agentId/sessionId was not rejected", "the '..' guard in lib/cli-system/cli-surface-inspector.js (~L46-53) must reject traversal segments on session_transcript / session_system_prompt params"),

  // ── graph 完整性 / group ─────────────────────────────────────────────────────
  "E-GRAPH-001": entry("graph", "graph edge endpoint is not a configured agent", "check control-plane/agent-graph.json; re-add edges via POST /watchdog/graph/edge/add"),
  "E-GRAPH-002": entry("graph", "agent graph has zero edges (reset residue)", "POST /watchdog/reset is known to leave a 0-edge topology; rebuild via POST /watchdog/graph/edge/add; truth file ~/.openclaw/control-plane/agent-graph.json"),
  "E-GRAPH-003": entry("graph", "agent unreachable from any entry node (orphan)", "inspect.agent_graph + inspect.agent_workflows show the components; wire the agent with POST /watchdog/graph/edge/add or retire it"),
  "E-GRAPH-004": entry("graph", "edge add/delete round-trip failed", "POST /watchdog/graph/edge/add then /watchdog/graph/edge/delete (routes/api.js ~L350-351); SSE graph_updated should fire on each mutation"),
  "E-GRAPH-005": entry("graph", "cycle detection mismatch vs registered loops", "GET /watchdog/graph returns cycles from detectCycles; compare with GET /watchdog/graph/loops; a registered loop whose cycle vanished means edges were deleted underneath it"),
  "E-GRAPH-006": entry("graph", "agent group compose or macro-expansion invalid", "POST /watchdog/graph/group/compose; spec rules in agent-group-spec.js (normalizeGroupSpec/expandAgentGroup): >=2 members, outputMode passthrough|aggregate|race, internal edges expanded with groupId"),
  "E-GRAPH-007": entry("graph", "workflow components do not cover all graph nodes", "inspect.agent_workflows builds undirected connected components (lib/cli-system/cli-surface-inspector.js ~L80); the member sum must equal the node count"),

  // ── harness ─────────────────────────────────────────────────────────────────
  "E-HARNESS-001": entry("harness", "module catalog drift (expected 10 modules / 4 kinds)", "listHarnessModuleCatalog() in lib/harness/harness-module-catalog.js: guards budget/tool_access/scope, collectors artifact/trace, gates artifact/schema/test, normalizers eval_input/failure"),
  "E-HARNESS-002": entry("harness", "harness registry counts drift (expected modules:10 profiles:4)", "summarizeHarnessRegistry() in lib/harness/harness-registry.js; profiles: coding.patch_and_test, experiment.research_cycle, evaluation.score_and_verdict, stage.completion"),
  "E-HARNESS-003": entry("harness", "composition validator returned a wrong problem set", "validateHarnessComposition in lib/harness/harness-composition.js; expected codes no_gate/no_guard/gate_without_collector/eval_input_without_artifact_collector; empty moduleRefs = legal freeform"),
  "E-HARNESS-004": entry("harness", "placement has an unresolvable moduleRef or edit round-trip failed", "GET /watchdog/harness placements (lib/harness/harness-dashboard.js); edit via POST /watchdog/automations/update {automationId, harness:{moduleRefs}} then re-read placements"),
  "E-HARNESS-005": entry("harness", "no fresh HarnessRun evidence after a live dispatch", "inspect.harness_runs plus files under ~/.openclaw/research-lab/harness-runs/; the agent_end hook persists one run per finalized session — if absent, check the agent_end pipeline"),

  // ── loop ────────────────────────────────────────────────────────────────────
  "E-LOOP-001": entry("loop", "loop compose rejected", "POST /watchdog/graph/loop/compose (routes/api.js ~L352-357) needs loopId+agents+entryAgentId; the loop path must already be covered by graph edges (edge = authorization)"),
  "E-LOOP-002": entry("loop", "budget echo mismatch on compose", "compose response must echo {resolvedBudget,budgetSource} from lib/loop/loop-budget.js; maxRounds:'' normalizes to null → budgetSource.maxRounds==='default' and resolvedBudget.maxRounds===3"),
  "E-LOOP-003": entry("loop", "registered loop has missing graph edges", "GET /watchdog/graph/loops: loop.missingEdges must be []; re-add the missing edges via POST /watchdog/graph/edge/add"),
  "E-LOOP-004": entry("loop", "loop session stuck without terminal outcome", "inspect.loop_sessions / inspect.active_loop_session; file truth ~/.openclaw/research-lab/loop_session_state.json; v121 regression class: hasActionableHeartbeatWork must treat a bound contract as real work"),
  "E-LOOP-005": entry("loop", "loop budget not enforced (rounds exceeded maxRounds)", "evaluateLoopBudgetGovernance must force-conclude with terminal outcome loop_budget_exhausted:max_rounds; precedence DEFAULT<LoopSpec<budget<config in lib/loop/loop-budget.js"),
  "E-LOOP-006": entry("loop", "loop delete/repair failed", "POST /watchdog/graph/loop/delete or /watchdog/graph/loop/repair (routes/api.js ~L364-365); after delete, inspect.graph_loops must no longer list the loop"),
  "E-LOOP-007": entry("loop", "loop start refused", "POST /watchdog/runtime/loop/start {loopId,startAgent} (routes/api.js ~L396-412); the loop must be registered and startAgent must be a member"),
  "E-LOOP-SKIP": entry("loop", "loop checks skipped: graph lacks a registered runnable cycle", "compose one via POST /watchdog/graph/loop/compose over existing edges, then rerun; current registrations visible at inspect.graph_loops"),

  // ── contract 生命周期 / 产物流转 ──────────────────────────────────────────────
  "E-CONTRACT-001": entry("contract", "contract never created after ingress", "ingress should mint a TC-* via dispatchAcceptIngressMessage; check GET /watchdog/work-items and ~/.openclaw/control-plane/contracts/; the inject response body carries the refusal reason"),
  "E-CONTRACT-002": entry("contract", "contract not terminal within budget", "terminal set defined by CONTRACT_STATUS in lib/core/runtime-status.js; inspect the stuck stage via inspect.session_transcript; clean up with POST /watchdog/tests/terminalize"),
  "E-CONTRACT-003": entry("contract", "contract ended failed", "read the shared contract JSON in control-plane/contracts/TC-*.json (runtimeDiagnostics/executionIncident) and the last agent session via inspect.session_transcript"),
  "E-CONTRACT-004": entry("contract", "completed contract output not mirrored", "v133 mirror-bug regression point: the shared contract 'output' must be non-empty on completion; the mirror reads the committed contract snapshot in the outbox-collection path (collectWorkerOutbox)"),
  "E-CONTRACT-005": entry("contract", "artifact package missing for contract", "expect files under ~/.openclaw/control-plane/artifacts/<contractId>/ after a producing run; producer-subdir depth varies — assert presence, not exact layout"),
  "E-CONTRACT-006": entry("contract", "upstream package not delivered downstream", "the downstream inbox must contain upstream/<producer>/ plus an upstreamPackages pointer in the staged contract.json (runtime-mailbox.js ~L45-67)"),
  "E-CONTRACT-007": entry("contract", "output validation failed (minBytes/keywords)", "evaluateOutputValidation in lib/test-output-validation.js; read the produced output path from the contract snapshot before blaming the validator"),
  "E-CONTRACT-008": entry("contract", "queue entry references a terminal contract (stale queue)", "~/.openclaw/control-plane/queue-state.json targets[].queue must only hold non-terminal contracts; check conveyor dequeue on terminalization"),

  // ── dispatch / 队列 ──────────────────────────────────────────────────────────
  "E-DISPATCH-001": entry("dispatch", "test inject rejected", "POST /watchdog/tests/inject (routes/api.js ~L121-148) → admin surface test.inject (lib/admin/admin-surface-operations.js); a non-ok body usually means a missing message field or an ingress refusal — read the response body"),
  "E-DISPATCH-002": entry("dispatch", "dispatch queue not draining while targets are idle", "GET /watchdog/runtime: dispatchQueue entries vs targets busy flags; persistence in control-plane/queue-state.json; the conveyor dispatch loop owns delivery"),
  "E-DISPATCH-003": entry("dispatch", "expected inbox_dispatch event never observed", "SSE /watchdog/stream should broadcast inbox_dispatch (lib/core/event-types.js); poll GET /watchdog/work-items to distinguish event loss from dispatch loss"),
  "E-DISPATCH-004": entry("dispatch", "targeted agent wake failed", "POST /hooks/agent with Authorization: Bearer <hook token> (core gateway route; see wakeAgentNow in lib/formal-runtime/infra.js); tokens load from ~/.openclaw/openclaw.json"),

  // ── delivery ────────────────────────────────────────────────────────────────
  "E-DELIVERY-001": entry("delivery", "delivery ticket not created", "inspect.delivery_tickets / file control-plane/system-action-delivery-tickets.json; SSE delivery_created should fire when terminal output routes outward"),
  "E-DELIVERY-002": entry("delivery", "delivery ticket created but never notified", "SSE delivery_notified missing; check terminal delivery routing in lib/routing/delivery-terminal.js"),
  "E-DELIVERY-003": entry("delivery", "test_run replyTo delivery did not route back to the run", "replyTo.kind==='test_run' routing lives in lib/routing/delivery-terminal.js (~L180-186); the run registry must receive the delivery"),

  // ── system-action 探针 ───────────────────────────────────────────────────────
  "E-SYSACTION-001": entry("system-action", "[ACTION] marker not emitted or not parsed", "the agent reply must contain the [ACTION] marker; read the session transcript via inspect.session_transcript to see whether the agent or the bridge parser failed"),
  "E-SYSACTION-002": entry("system-action", "create_task probe chain broken", "expected SSE chain: hook session start → session end → bridge alert system_action_runtime_result_delivered → same-session resume → bridge contract terminal in /watchdog/work-items"),
  "E-SYSACTION-003": entry("system-action", "assign_task result not delivered", "expect intermediate alert agent_task_assigned then system_action_assign_task_result_delivered; check the system-action bridge and delivery tickets"),
  "E-SYSACTION-004": entry("system-action", "request_review verdict not delivered", "expect code_review_requested then system_action_review_verdict_delivered; reviewer topology resolves by role — confirm a reviewer-capable agent exists in the graph"),
  "E-SYSACTION-005": entry("system-action", "same-session resume failed after bridge result", "the resumed run must reuse the original sessionKey; compare track_start sessionKeys in the SSE stream; resume semantics live in the system-action bridge"),

  // ── operator ────────────────────────────────────────────────────────────────
  "E-OPERATOR-001": entry("operator", "operator plan failed", "POST /watchdog/operator/plan is LLM-backed (lib/operator/operator-brain.js); check the brain model chain and provider quota; PLANNER_JSON_PARSE_FAILED intentionally does not trigger provider fallback"),
  "E-OPERATOR-002": entry("operator", "apply step refused unexpectedly", "the step surface must be operatorExecutable in lib/cli-system/cli-surface-registry.js; read the step result error; handlers in lib/admin/admin-surface-operations.js"),
  "E-OPERATOR-003": entry("operator", "destructive step executed WITHOUT explicitConfirm (C2 violation)", "POST /watchdog/operator/execute must refuse destructive steps lacking explicitConfirm:true (routes/api.js ~L444); this is a safety regression — fix before anything else"),
  "E-OPERATOR-004": entry("operator", "dryRun produced side effects", "operator execute with dryRun:true must mutate nothing; diff a structure snapshot before/after (POST /watchdog/control-plane/snapshot + /verify)"),
  "E-OPERATOR-005": entry("operator", "forced verify gate did not trigger after apply", "lib/cli-system/cli-surface-verify-gate.js (VERIFY_SURFACE_ID='test_runs.start') must launch verification after operator apply; the change-set commit gate lives in lib/admin/admin-change-set-executor.js"),
  "E-OPERATOR-006": entry("operator", "surface ownership violation not rejected", "assertActorOwnsSurface in lib/cli-system/meta-agent-surface-ownership.js: viz-master owns the chart family only; operator owns *; no actor → throw"),
  "E-OPERATOR-007": entry("operator", "structure rollback failed", "POST /watchdog/control-plane/rollback → restoreStructureSnapshot (lib/operator/structure-snapshot.js, honors expectHash); verify afterwards via /watchdog/control-plane/verify"),
  "E-OPERATOR-008": entry("operator", "meta.delegate guard failed", "meta.delegate steps are operator-only with a one-hop depth limit (lib/operator/operator-executor.js ~L121-136); unknown delegate target must error"),
  "E-OPERATOR-SKIP": entry("operator", "operator LLM plan check skipped: planner provider unreachable", "restore the brain provider chain (agents.defaults.model in ~/.openclaw/openclaw.json; resolveBrainModelChain in lib/operator/brain-model-resolver.js) to enable the LLM plan check; the deterministic operator checks still ran"),

  // ── explicit-confirm 闸 ──────────────────────────────────────────────────────
  "E-CONFIRM-001": entry("confirm", "confirm-gated route accepted without explicitConfirm", "all destructive routes (agents/delete, agents/hard-delete, reset, schedules/delete, automations/delete, agent-joins/delete, knowledge/remove, charts/delete) must return 400 without explicitConfirm (routes/api.js ~L347-431)"),

  // ── structure snapshot ──────────────────────────────────────────────────────
  "E-STRUCT-001": entry("structure", "structure snapshot create/read failed", "POST/GET /watchdog/control-plane/snapshot (routes/control-plane.js ~L47-88); snapshots persist under control-plane"),
  "E-STRUCT-002": entry("structure", "snapshot verify failed to detect a known mutation", "sequence snapshot → mutate one edge → POST /watchdog/control-plane/verify must report a diff; comparator in lib/operator/structure-snapshot.js"),
  "E-STRUCT-003": entry("structure", "rollback did not restore the snapshot", "POST /watchdog/control-plane/rollback then /verify must match; restoreStructureSnapshot(id,{expectHash}) in lib/operator/structure-snapshot.js (~L124)"),
  "E-STRUCT-004": entry("structure", "structure preview mutated live state", "inspect.structure_preview → projectStructureAfter must be non-destructive (lib/operator/structure-snapshot.js ~L182); diff the live graph before/after the preview call"),

  // ── knowledge / RAG ─────────────────────────────────────────────────────────
  "E-KNOWLEDGE-001": entry("knowledge", "wiki knowledge base missing or empty", "inspect.knowledge_bases (lib/knowledge/knowledge-base.js) must list the wiki KB with chunks>0; registry file control-plane/knowledge-bases.json; rebuild via apply.wiki_reindex"),
  "E-KNOWLEDGE-002": entry("knowledge", "search degraded although embeddings should be available", "searchWiki sets degraded when embed fails (hybrid → lexical-only); check ollama at localhost:11434 with model nomic-embed-text"),
  "E-KNOWLEDGE-003": entry("knowledge", "known-good query returned zero results", "even with embeddings down the lexical BM25-lite fallback must return results (v142); probe inspect.knowledge_search?query=...; if empty the KB index is broken — reindex"),
  "E-KNOWLEDGE-004": entry("knowledge", "recall floor breached", "evaluateWikiRagRecall over tests/fixtures/wiki-rag-eval-set.json (24 cases); floors recall@10>=0.85 @5>=0.65 MRR>=0.5 (tests/wiki-rag-recall.test.js); a breach usually means a chunking/index change"),
  "E-KNOWLEDGE-005": entry("knowledge", "knowledge eval run not persisted", "POST /watchdog/knowledge/eval-run must append to control-plane/knowledge-eval-runs.json and appear in inspect.knowledge_eval_runs"),
  "E-KNOWLEDGE-SKIP": entry("knowledge", "knowledge recall checks skipped: ollama embeddings unavailable", "start ollama (localhost:11434, model nomic-embed-text) to enable embedding-gated recall checks; lexical-only checks still apply"),

  // ── prompt 六层装配 ──────────────────────────────────────────────────────────
  "E-PROMPT-001": entry("prompt", "session system prompt report unavailable", "inspect.session_system_prompt?agentId=&sessionId= (lib/prompt/agent-session-system-prompt.js); the live session may be cleaned — archived snapshots are written at agent_end"),
  "E-PROMPT-002": entry("prompt", "activePath discriminator wrong", "contract sessionKey ⇒ 'dispatch-agent-awake' (wake layer present), user-direct ⇒ 'direct-soul'; discriminator in agent-session-system-prompt.js (~L455-458)"),
  "E-PROMPT-003": entry("prompt", "six-layer assembly shape broken", "layers[] must hold 6 entries (framework/tools/skill-heads/role-persona/SOUL/wake); wake.present must equal (activePath==='dispatch-agent-awake'); WHY in wiki/concepts/prompt-assembly.md"),
  "E-PROMPT-004": entry("prompt", "managed marker violation in workspace docs", "IDENTITY.md must carry MANAGED_BOOTSTRAP_MARKER (lib/.../managed-doc-markers.js); SOUL.md/WAKE.md are user-owned and must NOT be marker-managed (agent-enrollment-discovery.js ~L33-39)"),

  // ── workspace guidance ──────────────────────────────────────────────────────
  "E-GUIDANCE-001": entry("guidance", "managed guidance file missing for role", "getManagedGuidanceFilesForRole (agent-enrollment-discovery.js ~L61-65): execution roles need IDENTITY+HEARTBEAT, other roles the full 7-file set; resync runs at gateway start"),
  "E-GUIDANCE-002": entry("guidance", "guidance drift state unhealthy", "inspect.guidance_drift / file control-plane/guidance-drift-state.json; 'missing' in the expected set for an active agent means workspace sync failed"),
  "E-GUIDANCE-003": entry("guidance", "guidance write outside whitelist accepted", "POST /watchdog/agents/guidance/write must reject files outside the managed∪optional set (routes/operator-catalog.js ~L123-146)"),

  // ── model chain / provider ──────────────────────────────────────────────────
  "E-MODEL-001": entry("model", "brain model chain empty or unresolvable", "resolveBrainModelChain (lib/operator/brain-model-resolver.js): primary from agents.defaults.model.primary plus fallbacks; every entry needs baseUrl+apiKey (inline/env:/file:) in ~/.openclaw/openclaw.json"),
  "E-MODEL-002": entry("model", "provider fallback misbehavior", "the provider_fallback SSE event must fire only on provider errors and never on PLANNER_JSON_PARSE_FAILED (lib/operator/operator-brain.js ~L280-291)"),
  "E-MODEL-003": entry("model", "model registry missing the configured default", "GET /watchdog/models (routes/operator-catalog.js ~L383-396) must list the configured default model/provider"),

  // ── SSE ─────────────────────────────────────────────────────────────────────
  "E-SSE-001": entry("sse", "SSE stream connect failed", "GET /watchdog/stream?token= (routes/dashboard.js ~L104-136) — /watchdog/events does NOT exist; check the auth token and gateway health first"),
  "E-SSE-002": entry("sse", "no connected/heartbeat event within deadline", "the stream must send 'connected' promptly and 'heartbeat' every ~25s; if connect works but events stall, check the SSE client registry in routes/dashboard.js"),
  "E-SSE-003": entry("sse", "expected runtime event missing from the stream", "broadcast vocabulary lives in lib/core/event-types.js (inbox_dispatch, delivery_*, loop_*, test_run_*, graph_updated, ...); verify the producing subsystem fired before blaming SSE"),

  // ── schedules ───────────────────────────────────────────────────────────────
  "E-SCHEDULE-001": entry("schedule", "schedule lifecycle round-trip failed", "schedules.create/update/enable/disable/delete (delete is confirm-gated) surfaces; registry file control-plane/schedule-registry.json; list via GET /watchdog/schedules"),

  // ── crash recovery ──────────────────────────────────────────────────────────
  "E-RECOVERY-001": entry("recovery", "crash-recovery state stale or orphaned", "control-plane/watchdog-state.json: savedAt must advance; resumableTrackingSessions must not reference terminal contracts; ghost-retry guard pendingRetryTimers in lib/lifecycle/crash-recovery.js"),

  // ── config（平台配置文件本身）────────────────────────────────────────────────
  "E-CONFIG-001": entry("config", "openclaw.json failed to parse or lacks required shape", "read ~/.openclaw/openclaw.json: must be valid JSON (UTF-8, no BOM) with non-empty agents.list[] (unique ids) and gateway.auth.token; everything downstream (auth, dispatch, graph integrity) depends on this file"),

  // ── runner 自身 ──────────────────────────────────────────────────────────────
  "E-RUNNER-001": entry("runner", "suite crashed with an unhandled exception", "see evidence for the stack; fix the suite module under lib/formal-runtime/checks/; a suite must add checks, never throw at top level"),
  "E-RUNNER-002": entry("runner", "suite or check exceeded its time budget", "check the runner's timeout policy (heritage: lib/test-timeout-policy.js); long LLM cases need progress-leased budgets, not bigger constants"),
  "E-RUNNER-003": entry("runner", "gateway unreachable — gateway-dependent checks blocked", "start the gateway (bash ~/.openclaw/start.sh, port 18789) and rerun; pure NODE checks still ran"),
  "E-RUNNER-004": entry("runner", "suite emitted an invalid CheckResult", "check-runner add-time validation failed (lib/formal-runtime/checks/check-runner.js): fail/blocked/skip need a code registered in lib/formal-runtime/error-codes.js; pass must omit code"),
  "E-RUNNER-005": entry("runner", "blocked: a prerequisite check failed earlier in this run", "see evidence for the failed prerequisite check id; fix that root cause first — these checks did not run"),
});

// 取单个码；未注册返回 null。
export function getErrorCode(id) {
  if (typeof id !== "string") return null;
  return ERROR_CODES[id] || null;
}

// 列出全部码（数组形态，含 id）。
export function listErrorCodes() {
  return Object.entries(ERROR_CODES).map(([id, meta]) => ({ id, ...meta }));
}
