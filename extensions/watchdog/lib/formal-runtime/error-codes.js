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
  "E-GRAPH-004": entry("graph", "edge add/delete round-trip failed", "POST /watchdog/graph/edge/add then /watchdog/graph/edge/delete (routes/api.js ~L350-351); SSE graph_updated should fire on each mutation"),
  "E-GRAPH-006": entry("graph", "agent group compose or macro-expansion invalid", "POST /watchdog/graph/group/compose; spec rules in agent-group-spec.js (normalizeGroupSpec/expandAgentGroup): >=2 members, outputMode passthrough|aggregate|race, internal edges expanded with groupId"),
  "E-GRAPH-007": entry("graph", "workflow components do not cover all graph nodes", "inspect.agent_workflows builds undirected connected components (lib/cli-system/cli-surface-inspector.js ~L80); the member sum must equal the node count"),

  // ── contract 生命周期 / 产物流转 ──────────────────────────────────────────────
  "E-CONTRACT-001": entry("contract", "contract never created after ingress", "ingress should mint a TC-* via dispatchAcceptIngressMessage; check GET /watchdog/work-items and the run tree ~/.openclaw/control-plane/threads/<t>/runs/<r>/contracts/; the inject response body carries the refusal reason"),
  "E-CONTRACT-002": entry("contract", "contract not terminal within budget", "terminal set defined by CONTRACT_STATUS in lib/core/runtime-status.js; inspect the stuck stage via inspect.session_transcript; clean up with POST /watchdog/tests/terminalize"),
  "E-CONTRACT-003": entry("contract", "contract ended failed", "read the shared contract JSON in the run tree control-plane/threads/<t>/runs/<r>/contracts/TC-*.json (resolve via contract-index.jsonl) (runtimeDiagnostics/executionIncident) and the last agent session via inspect.session_transcript"),
  "E-CONTRACT-004": entry("contract", "completed contract output not mirrored", "v133 mirror-bug regression point: a completed contract must expose a readable deliverable — tree rounds seal it at threads/<t>/runs/<r>/participants/<agent>/outbox-<cid>/seal.json (primary file), direct-write and real-dir fallback rounds still land at contract.output"),
  "E-CONTRACT-006": entry("contract", "upstream package not delivered downstream", "probe wants contract-scoped DOWNSTREAM evidence: a downstream inbox holding upstream/<producer>/ with >=1 file, read from the agent_end snapshot threads/<threadId>/runs/<runId>/participants/<agentId>/inbox-<contractId>/ (snapshotInboxToRunTree writes it before cleanInbox) or — inside the window before that snapshot lands — from a live workspace inbox whose contract.json id equals this contract. When contract.json carries an upstreamPackages pointer it must list that producer (writeUpstreamPackagesPointer in lib/routing/mailbox/runtime-mailbox.js ~L50-58). The producer's own tree outbox participants/<producer>/outbox-<cid>/ is deliberately NOT evidence here — it exists whether or not the downstream ever received the package, so its presence proves production, not delivery"),
  "E-CONTRACT-007": entry("contract", "output validation failed (minBytes/keywords)", "evaluateOutputValidation in lib/formal-runtime/test-output-validation.js; read the produced output path from the contract snapshot before blaming the validator"),
  "E-CONTRACT-008": entry("contract", "queue entry references a terminal contract (stale queue)", "~/.openclaw/control-plane/queue-state.json targets[].queue must only hold non-terminal contracts; check conveyor dequeue on terminalization"),

  // ── dispatch / 队列 ──────────────────────────────────────────────────────────
  "E-DISPATCH-001": entry("dispatch", "test inject rejected", "POST /watchdog/tests/inject (routes/api.js ~L121-148) → admin surface test.inject (lib/admin/operations/admin-surface-operations.js); a non-ok body usually means a missing message field or an ingress refusal — read the response body"),
  "E-DISPATCH-002": entry("dispatch", "dispatch queue not draining while targets are idle", "GET /watchdog/runtime: dispatchQueue entries vs targets busy flags; persistence in control-plane/queue-state.json; the conveyor dispatch loop owns delivery"),
  "E-DISPATCH-003": entry("dispatch", "expected inbox_dispatch event never observed", "SSE /watchdog/stream should broadcast inbox_dispatch (lib/core/event-types.js); poll GET /watchdog/work-items to distinguish event loss from dispatch loss"),
  "E-DISPATCH-004": entry("dispatch", "targeted agent wake failed", "POST /hooks/agent with Authorization: Bearer <hook token> (core gateway route; see wakeAgentNow in lib/formal-runtime/infra.js); tokens load from ~/.openclaw/openclaw.json"),

  // ── concurrent 并发派工探针 ──────────────────────────────────────────────────
  "E-CONC-001": entry("concurrent", "concurrent injects were not all accepted as contracts", "each POST /watchdog/tests/inject must mint a distinct TC-* landing on the same planner caller; read the inject response body and GET /watchdog/work-items (probe markers embed in task text); driver lib/formal-runtime/suite-concurrent.js, verdict evaluateAcceptance in lib/formal-runtime/checks/concurrent-chain.js"),
  "E-CONC-002": entry("concurrent", "queue discipline violated under concurrency (busy slot shared, or FIFO activation order broken)", "poll GET /watchdog/runtime: trackingSessions must never show >1 running probe contract at once, and dispatchRuntime.targets[caller].queue must activate in creation order (conveyor FIFO); state truth lib/routing/dispatch/dispatch-runtime-state.js + control-plane/queue-state.json; evaluators evaluateBusySlotUniqueness/evaluateFifoActivation in lib/formal-runtime/checks/concurrent-chain.js"),
  "E-CONC-003": entry("concurrent", "double-bind: one contract claimed by more than one session", "compare track_start sessionKeys on /watchdog/stream — with the probe pinned to a single hop (ambiguity edge prep), a contract id must map to exactly one agent:<id>:contract:<cid> sessionKey (lib/session/session-keys.js); a second distinct claimer means dispatch handed the same contract out twice; evaluator evaluateNoDoubleBind in lib/formal-runtime/checks/concurrent-chain.js"),
  "E-CONC-004": entry("concurrent", "concurrent contracts did not all settle (terminal missing within budget, or caller busy slot not released afterwards)", "GET /watchdog/work-items must show every probe contract terminal (terminal set lib/core/runtime-status.js) and dispatchRuntime.targets[caller] must drop busy/currentContract/queue residue after settlement (release path lib/routing/dispatch/dispatch-runtime-state.js); stuck probes are force-terminalized via POST /watchdog/tests/terminalize for cleanup"),

  // ── delivery ────────────────────────────────────────────────────────────────
  "E-DELIVERY-001": entry("delivery", "delivery ticket not created", "inspect.delivery_tickets / file control-plane/system-action-delivery-tickets.json; SSE delivery_created should fire when terminal output routes outward"),
  "E-DELIVERY-002": entry("delivery", "delivery ticket created but never notified", "SSE delivery_notified missing; check terminal delivery routing in lib/routing/delivery/delivery-terminal.js"),
  "E-DELIVERY-003": entry("delivery", "test_run replyTo delivery did not route back to the run", "replyTo.kind==='test_run' routing lives in lib/routing/delivery/delivery-terminal.js (~L180-186); the run registry must receive the delivery"),

  // ── evidence 证据链（spec §3：证据不足反复出现 = 系统健康信号；码盯桥不盯 agent）─
  "E-EVIDENCE-001": entry("evidence", "sampled recent session trace ledgers structurally incomplete above threshold (evidence bridge suspect)", "this code indicts the recording pipeline, never the traced agents — an incomplete ledger means hooks→evidence-bridge→store dropped writes while the agent worked normally. Check the open/close sentinels + seq continuity of trace_event rows in records.db (lib/evidence/session-trace-store.js validateSessionTraceContent gives the per-session reason; the ledger lives in the records DB — file ledger retired), grep the gateway log for the bridge's swallowed warnings ('evidence append failed' / 'append failed (non-blocking)' from lib/evidence/evidence-bridge.js) and for record-plane rejections ('trace_event write rejected'), then run node extensions/watchdog/scripts/record-reconcile.js for per-session seq-gap listing"),

  // ── system-action 探针 ───────────────────────────────────────────────────────
  "E-SYSACTION-001": entry("system-action", "collab action was not accepted from the caller session", "L1 probe: the tool call must be accepted mid-session (check tool mounting in agents.list tools.allow, role policy, before-tool-call whitelist union); L3 probe: the [ACTION] marker must be extracted at agent_end (contract session with written output; graph-routed sessions only pass wake); intermediate alert = agent_task_assigned"),
  "E-SYSACTION-002": entry("system-action", "create_task known-but-denied chain broken", "create_task is a deferred-build intent (collaboration-intent-policy roles=[]) — the probe asserts the structured rejection: expect alert system_action_role_policy_rejected from the caller, and the caller contract must still reach a normal terminal (a denied action must not fail the caller)"),
  "E-SYSACTION-003": entry("system-action", "assign_task result not delivered", "contract-session probe: expect agent_task_assigned then system_action_assign_task_result_delivered; caller must be an assign-authorized role (planner) with the L1 tool mounted, and its contract replyTo must name a distinct upstream for the return ticket"),
  "E-SYSACTION-005": entry("system-action", "same-session resume failed after bridge result", "the resumed run must reuse the original sessionKey; compare track_start sessionKeys in the SSE stream; resume semantics live in the system-action bridge"),

  // ── operator ────────────────────────────────────────────────────────────────
  "E-OPERATOR-001": entry("operator", "operator plan failed", "POST /watchdog/operator/plan is LLM-backed (lib/operator/operator-brain.js); check the brain model chain and provider quota; PLANNER_JSON_PARSE_FAILED intentionally does not trigger provider fallback"),
  "E-OPERATOR-002": entry("operator", "apply step refused unexpectedly", "the step surface must be operatorExecutable in lib/cli-system/cli-surface-registry.js; read the step result error; handlers in lib/admin/operations/admin-surface-operations.js"),
  "E-OPERATOR-003": entry("operator", "destructive step executed WITHOUT explicitConfirm (C2 violation)", "POST /watchdog/operator/execute must refuse destructive steps lacking explicitConfirm:true (routes/api.js ~L444); this is a safety regression — fix before anything else"),
  "E-OPERATOR-004": entry("operator", "dryRun produced side effects", "operator execute with dryRun:true must mutate nothing; diff a structure snapshot before/after (POST /watchdog/control-plane/snapshot + /verify)"),
  "E-OPERATOR-005": entry("operator", "forced verify gate did not trigger after apply", "lib/cli-system/cli-surface-verify-gate.js (VERIFY_SURFACE_ID='test_runs.start') must launch verification after operator apply; the change-set commit gate lives in lib/admin/change-sets/admin-change-set-executor.js"),
  "E-OPERATOR-006": entry("operator", "surface ownership violation not rejected", "assertActorOwnsSurface in lib/cli-system/meta-agent-surface-ownership.js: viz-master owns the chart family only; operator owns *; no actor → throw"),
  "E-OPERATOR-007": entry("operator", "structure rollback failed", "POST /watchdog/control-plane/rollback → restoreStructureSnapshot (lib/control-plane/structure-snapshot.js, honors expectHash); verify afterwards via /watchdog/control-plane/verify"),
  "E-OPERATOR-008": entry("operator", "meta.delegate guard failed", "meta.delegate steps are operator-only with a one-hop depth limit (lib/operator/operator-executor.js ~L121-136); unknown delegate target must error"),
  "E-OPERATOR-SKIP": entry("operator", "operator LLM plan check skipped: planner provider unreachable", "restore the brain provider chain (agents.defaults.model in ~/.openclaw/openclaw.json; resolveBrainModelChain in lib/llm/brain-model-resolver.js) to enable the LLM plan check; the deterministic operator checks still ran"),

  // ── explicit-confirm 闸 ──────────────────────────────────────────────────────
  "E-CONFIRM-001": entry("confirm", "confirm-gated route accepted without explicitConfirm", "all destructive routes (agents/delete, agents/hard-delete, reset, schedules/delete, automations/delete, agent-joins/delete, knowledge/remove, charts/delete) must return 400 without explicitConfirm (routes/api.js ~L347-431)"),

  // ── structure snapshot ──────────────────────────────────────────────────────
  "E-STRUCT-001": entry("structure", "structure snapshot create/read failed", "POST/GET /watchdog/control-plane/snapshot (routes/control-plane.js ~L47-88); snapshots persist under control-plane"),
  "E-STRUCT-002": entry("structure", "snapshot verify failed to detect a known mutation", "sequence snapshot → mutate one edge → POST /watchdog/control-plane/verify must report a diff; comparator in lib/control-plane/structure-snapshot.js"),
  "E-STRUCT-003": entry("structure", "rollback did not restore the snapshot", "POST /watchdog/control-plane/rollback then /verify must match; restoreStructureSnapshot(id,{expectHash}) in lib/control-plane/structure-snapshot.js (~L124)"),
  "E-STRUCT-004": entry("structure", "structure preview mutated live state", "inspect.structure_preview → projectStructureAfter must be non-destructive (lib/control-plane/structure-snapshot.js ~L182); diff the live graph before/after the preview call"),

  // ── knowledge / RAG ─────────────────────────────────────────────────────────
  "E-KNOWLEDGE-001": entry("knowledge", "wiki knowledge base missing or empty", "inspect.knowledge_bases (lib/knowledge/knowledge-base.js) must list the wiki KB with chunks>0; registry file control-plane/knowledge-bases.json; rebuild via apply.wiki_reindex"),
  "E-KNOWLEDGE-002": entry("knowledge", "search degraded although embeddings should be available", "searchWiki sets degraded when embed fails (hybrid → lexical-only); check ollama at localhost:11434 with model nomic-embed-text"),
  "E-KNOWLEDGE-003": entry("knowledge", "known-good query returned zero results", "even with embeddings down the lexical BM25-lite fallback must return results (v142); probe inspect.knowledge_search?query=...; if empty the KB index is broken — reindex"),
  "E-KNOWLEDGE-004": entry("knowledge", "recall floor breached", "evaluateWikiRagRecall over tests/fixtures/wiki-rag-eval-set.json (24 cases); floors recall@10>=0.85 @5>=0.65 MRR>=0.5 (tests/wiki-rag-recall.test.js); a breach usually means a chunking/index change"),
  "E-KNOWLEDGE-005": entry("knowledge", "knowledge eval run not persisted", "POST /watchdog/knowledge/eval-run must append to control-plane/knowledge-eval-runs.json and appear in inspect.knowledge_eval_runs"),
  "E-KNOWLEDGE-SKIP": entry("knowledge", "knowledge recall checks skipped: ollama embeddings unavailable", "start ollama (localhost:11434, model nomic-embed-text) to enable embedding-gated recall checks; lexical-only checks still apply"),

  // ── viz / chart (viz-master meta-agent) ──────────────────────────────────────
  "E-VIZ-001": entry("viz", "chart create via the viz-master meta-agent executor failed for a valid spec", "executeCliSystemSurface({surfaceId:'apply.chart_create', actor:'viz-master', payload:{spec}}) must return {ok:true, chart}; the handler is createChartDefinition→upsertChart (lib/admin/chart-operations.js, lib/control-plane/chart-registry.js). ok:false for a VALID spec means the executor/ownership/handler chain broke — check the spec passes validateChartSpec (lib/viz/chart-spec-schema.js) first"),
  "E-VIZ-002": entry("viz", "created chart absent from inspect.charts (create→persist→inspect round-trip broken)", "inspect.charts (lib/cli-system/cli-surface-inspector.js → listCharts in lib/control-plane/chart-registry.js, reads control-plane/charts.json) must list a chart right after apply.chart_create returns ok; a miss means the upsert did not persist or inspect reads a stale/wrong store"),
  "E-VIZ-003": entry("viz", "malformed chart spec was accepted (validateChartSpec gate hole)", "a spec violating the contract (missing series, sse binding on a non-line type, bad id) must come back {ok:false, error}; validateChartSpec in lib/viz/chart-spec-schema.js is the single gate — createChartDefinition catches its throw into ok:false. Acceptance means the validator or its wiring regressed"),
  "E-VIZ-004": entry("viz", "chart delete did not remove the probe chart (cleanup/idempotent-delete broken)", "apply.chart_delete → deleteChart (lib/control-plane/chart-registry.js) is idempotent and must leave inspect.charts without the id; a lingering probe chart means delete failed to persist — the suite force-deletes in finally, so a lingering chart is a real store bug"),

  // ── prompt 六层装配 ──────────────────────────────────────────────────────────
  "E-PROMPT-001": entry("prompt", "session system prompt report unavailable", "inspect.session_system_prompt?agentId=&sessionId= (lib/agent/agent-session-system-prompt.js); the live session may be cleaned — agent_end archives the report sidecar into the run tree threads/<t>/runs/<r>/participants/<agentId>/session-<sessionId>.prompt.json (home resolved via control-plane/session-index.jsonl)"),
  "E-PROMPT-002": entry("prompt", "activePath discriminator wrong", "contract sessionKey ⇒ 'dispatch-agent-awake' (wake layer present), user-direct ⇒ 'direct-soul'; discriminator in agent-session-system-prompt.js (~L455-458)"),
  "E-PROMPT-003": entry("prompt", "six-layer assembly shape broken", "layers[] must hold 6 entries (framework/tools/skill-heads/role-persona/SOUL/wake); wake.present must equal (activePath==='dispatch-agent-awake'); WHY in wiki/concepts/prompt-assembly.md"),
  "E-PROMPT-004": entry("prompt", "managed marker violation in workspace docs", "IDENTITY.md must carry MANAGED_BOOTSTRAP_MARKER (lib/prompt/managed-doc-markers.js); SOUL.md/WAKE.md are user-owned and must NOT be marker-managed (agent-enrollment-discovery.js ~L33-39)"),

  // ── workspace guidance ──────────────────────────────────────────────────────
  "E-GUIDANCE-001": entry("guidance", "managed guidance file missing for role", "getManagedGuidanceFilesForRole (agent-enrollment-discovery.js ~L61-65): execution roles need IDENTITY+HEARTBEAT, other roles the full 7-file set; resync runs at gateway start"),
  "E-GUIDANCE-002": entry("guidance", "guidance drift state unhealthy", "inspect.guidance_drift / file control-plane/guidance-drift-state.json; 'missing' in the expected set for an active agent means workspace sync failed"),
  "E-GUIDANCE-003": entry("guidance", "guidance write outside whitelist accepted", "POST /watchdog/agents/guidance/write must reject files outside the managed∪optional set (routes/operator-catalog.js ~L123-146)"),

  // ── model chain / provider ──────────────────────────────────────────────────
  "E-MODEL-001": entry("model", "brain model chain empty or unresolvable", "resolveBrainModelChain (lib/llm/brain-model-resolver.js): primary from agents.defaults.model.primary plus fallbacks; every entry needs baseUrl+apiKey (inline/env:/file:) in ~/.openclaw/openclaw.json"),
  "E-MODEL-002": entry("model", "provider fallback misbehavior", "the provider_fallback SSE event must fire only on provider errors and never on PLANNER_JSON_PARSE_FAILED (lib/operator/operator-brain.js ~L280-291)"),
  "E-MODEL-003": entry("model", "model registry missing the configured default", "GET /watchdog/models (routes/operator-catalog.js ~L383-396) must list the configured default model/provider"),
  "E-MODEL-004": entry("model", "provider endpoint unreachable or returned no data", "the model suite API leg (lib/formal-runtime/suite-model.js, check model.<provider>-api) sends small multi-format chat/completions probes (plain / system+user / JSON / CJK) to each credentialed remote provider in models.providers (~/.openclaw/openclaw.json); a fail = non-2xx / network error / empty completion — check the provider status, apiKey, and that models[0].id is served. This is the only check that proactively catches an upstream outage (e.g. ARK coding-plan 404 'does not support coding plan feature'); health's E-MODEL-001 only resolves the config, it never pings"),
  "E-MODEL-005": entry("model", "full-chain model task did not complete (contract failed / timed out / deliverable missing MODEL_OK)", "the model suite e2e leg (lib/formal-runtime/suite-model.js, check model.<provider>-e2e) binds a temp executor agent (model-probe-<slug>) to the model, direct-dispatches a minimal file-write task (createDirectRequestEnvelope + deliveryEnqueueSystemActionReturn — no ingress, no graph edges) and polls /watchdog/work-items for a terminal status within 180s; on fail read the DIRECT-* contract snapshot in the run tree control-plane/threads/<t>/runs/<r>/contracts/ and the probe agent session transcript to see whether the model ever emitted tool calls"),
  "E-MODEL-006": entry("model", "temp model-probe agent lifecycle failed (create or cleanup)", "createAgentDefinition/hardDeleteAgentDefinition (lib/agent/admin/agent-admin-create-delete.js) invoked by lib/formal-runtime/suite-model.js with ids model-probe-<slug>; there is NO automatic reclaim (withPreservedRuntimeGraph does not restore agents.list) — a lingering model-probe-* entry in ~/.openclaw/openclaw.json agents.list plus workspaces/model-probe-*/ must be removed manually"),
  "E-MODEL-SKIP": entry("model", "model probe skipped (no credentialed provider, non-openai protocol, or local provider offline)", "no credentialed provider found in models.providers, the provider api is not openai-completions (the probe would hit the wrong endpoint), or a local (localhost) provider is offline — start it (e.g. ollama) or add credentials; the e2e leg for a local provider is gated on its API leg passing, so bringing the endpoint up enables both legs; remote providers are always probed end to end and can still fail with E-MODEL-004/E-MODEL-005"),

  // ── SSE ─────────────────────────────────────────────────────────────────────
  "E-SSE-001": entry("sse", "SSE stream connect failed", "GET /watchdog/stream?token= (routes/dashboard.js ~L104-136) — /watchdog/events does NOT exist; check the auth token and gateway health first"),
  "E-SSE-002": entry("sse", "no connected/heartbeat event within deadline", "the stream must send 'connected' promptly and 'heartbeat' every ~25s; if connect works but events stall, check the SSE client registry in routes/dashboard.js"),
  "E-SSE-003": entry("sse", "expected runtime event missing from the stream", "broadcast vocabulary lives in lib/core/event-types.js (inbox_dispatch, delivery_*, automation_round_*, test_run_*, graph_updated, ...); verify the producing subsystem fired before blaming SSE"),

  // ── schedules ───────────────────────────────────────────────────────────────
  "E-SCHEDULE-001": entry("schedule", "schedule lifecycle round-trip failed", "schedules.create/update/enable/disable/delete (delete is confirm-gated) surfaces; registry file control-plane/schedule-registry.json; list via GET /watchdog/schedules"),

  // ── crash recovery ──────────────────────────────────────────────────────────
  "E-RECOVERY-001": entry("recovery", "crash-recovery state stale or orphaned", "control-plane/watchdog-state.json: savedAt must advance; resumableTrackingSessions must not reference terminal contracts; ghost-retry guard pendingRetryTimers in lib/lifecycle/crash-recovery.js"),

  // ── config（平台配置文件本身）────────────────────────────────────────────────
  "E-CONFIG-001": entry("config", "openclaw.json failed to parse or lacks required shape", "read ~/.openclaw/openclaw.json: must be valid JSON (UTF-8, no BOM) with non-empty agents.list[] (unique ids) and gateway.auth.token; everything downstream (auth, dispatch, graph integrity) depends on this file"),
  "E-CONFIG-002": entry("config", "collab tool face not mounted for a collaborating runtime agent", "agents.list[].tools.allow must name the role's exposed collab intents (or plugin id watchdog / group:plugins): planner needs assign_task; authorization truth = lib/system-action/collaboration-intent-policy.js; bridges are exempt (hook-session lockdown) and control-plane agents (operator/viz-master) are out of scope"),
  "E-CONFIG-003": entry("config", "watchdog plugin cfg failed boundary validation at register() (values derived from openclaw.json)", "field list is in the thrown message; fix the value in openclaw.json — validation is types/ranges only, empty strings are legal"),

  // ── kernel / boot（进程内装配期,区别于 config 段的配置文件形状）──────────────
  "E-BOOT-001": entry("kernel", "boot dependency ledger found required service without provider", "missing names and requesters are in the thrown message; add the matching bootLedger.provide() at the owning module's wiring in index.js gateway_start"),

  // ── toolface（协作 FC 工具面自身）────────────────────────────────────────────
  "E-TOOLFACE-001": entry("toolface", "collab tool-face definitions diverge from the intent policy", "lib/system-action/collaboration-toolface.js TOOL_DEFINITIONS keys must equal listExposedToolIntents() from collaboration-intent-policy.js; a new exposed intent needs a tool definition and vice versa"),
  "E-TOOLFACE-002": entry("toolface", "platform-service tool face diverges from the service table", "lib/system-action/platform-service-toolface.js must expose exactly listExposedPlatformServiceTools() from platform-service-tools.js; flipping a row to exposedAsTool:true without building its tool face (or the reverse) trips this. Deferred rows (submit_plan / report_progress) are expected to stay exposedAsTool:false"),

  // ── unit（npm test 全量单测收口）─────────────────────────────────────────────
  "E-UNIT-001": entry("unit", "npm test reported failing unit tests", "the unit suite (lib/formal-runtime/suite-unit.js) spawned `npm test` in extensions/watchdog and the trailing node --test totals show fail/cancelled > 0 — evidence lists the ✖ test names; rerun `npm test` locally and read the trailing '✖ failing tests:' section of the output"),
  "E-UNIT-002": entry("unit", "npm test could not run or be verified (spawn error, 600s timeout, unparsable totals, or agent-graph restore failure)", "infrastructure of lib/formal-runtime/suite-unit.js: `npm` must be on the gateway process PATH, node --test must print its trailing totals block ('ℹ tests/pass/fail') on stdout, and the pre-run snapshot of ~/.openclaw/control-plane/agent-graph.json must write back in finally (unit tests write the real control-plane — 2026-08-11 incident); the evidence carries the spawn/parse/restore error and the output tail"),

  // ── runner 自身 ──────────────────────────────────────────────────────────────
  "E-RUNNER-001": entry("runner", "suite crashed with an unhandled exception", "see evidence for the stack; fix the suite module under lib/formal-runtime/checks/; a suite must add checks, never throw at top level"),
  "E-RUNNER-002": entry("runner", "suite or check exceeded its time budget", "check the runner's timeout policy (heritage: lib/formal-runtime/test-timeout-policy.js); long LLM cases need progress-leased budgets, not bigger constants"),
  "E-RUNNER-003": entry("runner", "gateway unreachable — gateway-dependent checks blocked", "start the gateway (bash ~/.openclaw/start.sh, port 18789) and rerun; pure NODE checks still ran"),
  "E-RUNNER-004": entry("runner", "suite emitted an invalid CheckResult", "check-runner add-time validation failed (lib/formal-runtime/checks/check-runner.js): fail/blocked/skip need a code registered in lib/formal-runtime/error-codes.js; pass must omit code"),
  "E-RUNNER-005": entry("runner", "blocked: a prerequisite check failed earlier in this run", "see evidence for the failed prerequisite check id; fix that root cause first — these checks did not run"),
  "E-RUNNER-006": entry("runner", "live run created more contracts than the preset budget (runaway spawning)", "an agent is self-dispatching beyond the test plan (e.g. bridge re-dispatching on hook echoes); the run was aborted and active contracts abandoned via /watchdog/reset; inspect records.db contract_created rows past the run watermark to identify the spawner"),
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
