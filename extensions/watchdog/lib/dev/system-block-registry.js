import { sep } from "node:path";

export const SYSTEM_BLOCKS = Object.freeze([
  block({
    id: "runtime-core",
    title: "Runtime Core",
    purpose: "Own runtime truth objects and persistence primitives.",
    ownedTruth: ["contract", "message envelope", "runtime result", "ledger", "lock/store"],
    interfaces: ["contract store API", "runtime result protocol", "control-plane store paths"],
    minimalTests: ["extensions/watchdog/tests/contract-store.test.js", "extensions/watchdog/tests/runtime-result-protocol.test.js"],
    agentUse: "Assign this block when the task changes what the system considers true.",
    patterns: [
      /^extensions\/watchdog\/lib\/contracts\.js$/,
      /^extensions\/watchdog\/lib\/contract-store\.js$/,
      /^extensions\/watchdog\/lib\/contract-/,
      /^extensions\/watchdog\/lib\/runtime-result/,
      /^extensions\/watchdog\/lib\/runtime-status\.js$/,
      /^extensions\/watchdog\/lib\/protocol-commit-reconcile\.js$/,
      /^extensions\/watchdog\/lib\/control-plane\//,
      /^extensions\/watchdog\/lib\/store\//,
      /^extensions\/watchdog\/lib\/core\//,
      /^extensions\/watchdog\/lib\/state/,
      /^extensions\/watchdog\/lib\/[^/]*ledger[^/]*\.js$/,
      /^extensions\/watchdog\/lib\/[^/]*lock[^/]*\.js$/,
      /^extensions\/watchdog\/lib\/protocol-/,
      /^extensions\/watchdog\/protocol-registry\.js$/,
      /^extensions\/watchdog\/lib\/terminal-/,
      /^extensions\/watchdog\/lib\/[^/]*lease[^/]*\.js$/,
      /^extensions\/watchdog\/lib\/coordination-primitives\.js$/,
      /^extensions\/watchdog\/lib\/conversations\.js$/,
      /^extensions\/watchdog\/lib\/tracking-work-item\.js$/,
      /^extensions\/watchdog\/lib\/service-session\.js$/,
      /^extensions\/watchdog\/lib\/session-keys\.js$/,
      /^extensions\/watchdog\/lib\/runtime-contract-output-alias\.js$/,
      /^extensions\/watchdog\/lib\/runtime-activity\.js$/,
      /^extensions\/watchdog\/lib\/runtime-workflow-semantics\.js$/,
    ],
  }),
  block({
    id: "io-delivery",
    title: "IO Delivery",
    purpose: "Own external ingress normalization and user-visible return routing.",
    ownedTruth: ["external source identity", "replyTo", "delivery ticket", "channel egress"],
    interfaces: ["ingress route payload", "delivery API", "QQ/WebUI/test source binding"],
    minimalTests: ["extensions/watchdog/tests/a2a-ingress-return.test.js", "extensions/watchdog/tests/delivery-semantics.test.js"],
    agentUse: "Assign this block when changing how messages enter or leave OpenClaw.",
    patterns: [
      /^extensions\/watchdog\/lib\/ingress\//,
      /^extensions\/watchdog\/lib\/completion-egress\.js$/,
      /^extensions\/watchdog\/lib\/delivery/,
      /^extensions\/watchdog\/lib\/runtime-return-/,
      /^extensions\/watchdog\/routes\//,
      /^extensions\/qqbot\//,
      /^extensions\/watchdog\/lib\/channel-notify\.js$/,
      /^extensions\/watchdog\/lib\/route-metadata\.js$/,
      /^extensions\/watchdog\/lib\/qq-reply-target\.js$/,
      /^extensions\/watchdog\/lib\/runtime-user-facing-output\.js$/,
    ],
  }),
  block({
    id: "agent-assembly",
    title: "Agent Assembly",
    purpose: "Own how runtime identities are assembled from config, profile, policy, skills, and guidance.",
    ownedTruth: ["AgentBinding", "effective profile", "execution policy", "role spec", "skill exposure"],
    interfaces: ["agent binding store", "effective profile composer", "workspace guidance writer"],
    minimalTests: ["extensions/watchdog/tests/agent-binding-store-runtime-interop.test.js", "extensions/watchdog/tests/prompt-composition-minimal.test.js"],
    agentUse: "Assign this block when changing what an agent is allowed or instructed to be.",
    patterns: [
      /^extensions\/watchdog\/lib\/agent\//,
      /^extensions\/watchdog\/lib\/capability\//,
      /^extensions\/watchdog\/lib\/agent-binding-store\.js$/,
      /^extensions\/watchdog\/lib\/effective-profile-composer\.js$/,
      /^extensions\/watchdog\/lib\/capability-preset-registry\.js$/,
      /^extensions\/watchdog\/lib\/role-spec-registry\.js$/,
      /^extensions\/watchdog\/lib\/execution-policy-/,
      /^extensions\/watchdog\/lib\/profile-/,
      /^extensions\/watchdog\/lib\/workspace-guidance-/,
      /^extensions\/watchdog\/lib\/soul-/,
      /^extensions\/watchdog\/lib\/session-bootstrap\.js$/,
      /^extensions\/watchdog\/lib\/platform-doc-builder\.js$/,
      /^extensions\/watchdog\/lib\/collaboration-policy\.js$/,
      /^extensions\/watchdog\/lib\/semantic-skill-registry\.js$/,
      /^extensions\/watchdog\/lib\/brain-model-resolver\.js$/,
      /^extensions\/watchdog\/lib\/llm-planner\.js$/,
      /^skills\//,
    ],
  }),
  block({
    id: "local-execution",
    title: "Local Execution",
    purpose: "Own a single agent run lifecycle and local hook behavior.",
    ownedTruth: ["tracking state", "tool call window", "heartbeat signal", "agent lifecycle"],
    interfaces: ["before/after hooks", "heartbeat gate", "runtime mailbox"],
    minimalTests: ["extensions/watchdog/tests/agent-end-deferred-release.test.js", "extensions/watchdog/tests/max-tool-calls-hard-stop.test.js"],
    agentUse: "Assign this block when changing what happens inside one agent wake/run/end cycle.",
    patterns: [
      /^extensions\/watchdog\/hooks\//,
      /^extensions\/watchdog\/lib\/lifecycle\//,
      /^extensions\/watchdog\/lib\/runtime\//,
      /^extensions\/watchdog\/lib\/heartbeat-gate\.js$/,
      /^extensions\/watchdog\/lib\/agent-end-/,
      /^extensions\/watchdog\/lib\/runtime-lifecycle\.js$/,
      /^extensions\/watchdog\/runtime-mailbox\.js$/,
      /^extensions\/watchdog\/lib\/loop-detection/,
      /^extensions\/watchdog\/lib\/tool-/,
      /^extensions\/watchdog\/lib\/security\.js$/,
      /^extensions\/watchdog\/lib\/io-observation\.js$/,
      /^extensions\/watchdog\/lib\/execution-observation\.js$/,
      /^extensions\/watchdog\/lib\/hard-path-autoexec\.js$/,
      /^extensions\/watchdog\/lib\/finding-marker-parser\.js$/,
      /^extensions\/watchdog\/lib\/action-marker-parser\.js$/,
      /^extensions\/watchdog\/index\.js$/,
    ],
  }),
  block({
    id: "graph-dispatch-queue",
    title: "Graph Dispatch Queue",
    purpose: "Own graph authorization, conveyor dispatch, queueing, and pool claim/release.",
    ownedTruth: ["graph edge authorization", "conveyor dispatch", "runtime queue", "worker pool claim/release"],
    interfaces: ["agent graph API", "dispatch API", "queue state", "pool claim lifecycle"],
    minimalTests: ["extensions/watchdog/tests/dispatch-graph-policy.test.js", "extensions/watchdog/tests/dispatch-queue-maintenance.test.js"],
    agentUse: "Assign this block when changing who can send work to whom, or when work waits.",
    patterns: [
      /^extensions\/watchdog\/lib\/routing\//,
      /^extensions\/watchdog\/lib\/transport\//,
      /^extensions\/watchdog\/lib\/agent-graph\.js$/,
      /^extensions\/watchdog\/lib\/dispatch\.js$/,
      /^extensions\/watchdog\/lib\/dispatch-/,
      /^extensions\/watchdog\/lib\/conveyor\.js$/,
      /^extensions\/watchdog\/lib\/pool\.js$/,
      /^extensions\/watchdog\/lib\/routing\//,
      /^extensions\/watchdog\/lib\/router-handler-registry\.js$/,
      /^extensions\/watchdog\/lib\/queue-/,
      /^extensions\/watchdog\/lib\/runtime-direct-envelope-queue\.js$/,
    ],
  }),
  block({
    id: "loop-stage",
    title: "Loop Stage",
    purpose: "Own repeated graph-backed progression and stage projection truth.",
    ownedTruth: ["LoopSpec", "LoopSession", "stage result", "stage projection"],
    interfaces: ["graph loop registry", "loop session store", "stage projection API"],
    minimalTests: ["extensions/watchdog/tests/loop-epoch-isolation.test.js", "extensions/watchdog/tests/stage-projection.test.js"],
    agentUse: "Assign this block when changing loop progression, stages, or graph-backed repeated work.",
    patterns: [
      /^extensions\/watchdog\/lib\/loop\//,
      /^extensions\/watchdog\/lib\/graph-loop-registry\.js$/,
      /^extensions\/watchdog\/lib\/loop-session-store\.js$/,
      /^extensions\/watchdog\/lib\/loop-/,
      /^extensions\/watchdog\/lib\/pipeline-/,
      /^extensions\/watchdog\/lib\/stage-/,
      /^extensions\/watchdog\/lib\/graph-route-/,
      /^extensions\/watchdog\/lib\/task-stage-/,
      /^extensions\/watchdog\/lib\/runtime-stage-progress\.js$/,
      /^extensions\/watchdog\/lib\/lifecycle-stage-truth\.js$/,
    ],
  }),
  block({
    id: "harness-assurance",
    title: "Harness Assurance",
    purpose: "Own execution shaping, evidence capture, failure classification, and review bridge.",
    ownedTruth: ["HarnessRun", "module evidence", "failure classification", "review bridge payload"],
    interfaces: ["harness module contract", "harness runner", "evaluation bridge"],
    minimalTests: ["extensions/watchdog/tests/harness-module-contract.test.js", "extensions/watchdog/tests/harness-module-runner.test.js"],
    agentUse: "Assign this block when changing how execution is observed, shaped, or judged as evidence.",
    patterns: [
      /^extensions\/watchdog\/lib\/harness\//,
      /^extensions\/watchdog\/lib\/harness-/,
      /^extensions\/watchdog\/lib\/review-bridge\.js$/,
      /^extensions\/watchdog\/lib\/review-/,
      /^extensions\/watchdog\/lib\/pipeline-harness\.js$/,
      /^extensions\/watchdog\/lib\/runtime-fault-/,
      /^extensions\/watchdog\/lib\/artifact-lane-registry\.js$/,
    ],
  }),
  block({
    id: "operator-cli-control",
    title: "Operator CLI Control",
    purpose: "Own formal control surfaces for runtime inspection and controlled system action.",
    ownedTruth: ["operator snapshot", "CLI surface", "system action", "admin change set"],
    interfaces: ["operator snapshot API", "CLI system registry", "system action runtime", "admin surface"],
    minimalTests: ["extensions/watchdog/tests/cli-system-surface-basic.test.js", "extensions/watchdog/tests/operator-snapshot-summarizers.test.js"],
    agentUse: "Assign this block when changing system control, inspect/apply/verify, or operator-facing surfaces.",
    patterns: [
      /^extensions\/watchdog\/lib\/operator\//,
      /^extensions\/watchdog\/lib\/cli-system\//,
      /^extensions\/watchdog\/lib\/operator-/,
      /^extensions\/watchdog\/lib\/cli-/,
      /^extensions\/watchdog\/lib\/system-action\//,
      /^extensions\/watchdog\/lib\/admin\//,
      /^extensions\/watchdog\/routes\/operator-/,
      /^extensions\/watchdog\/routes\/admin-/,
      /^extensions\/watchdog\/lib\/management-registry-view\.js$/,
      /^extensions\/watchdog\/lib\/model-registry-view\.js$/,
    ],
  }),
  block({
    id: "automation-governance",
    title: "Automation Governance",
    purpose: "Own long-running automation, schedules, and governance decisions.",
    ownedTruth: ["automation registry", "automation runtime", "schedule trigger", "governance decision"],
    interfaces: ["automation executor", "schedule materializer", "profile lifecycle"],
    minimalTests: ["extensions/watchdog/tests/automation-store-locking.test.js", "extensions/watchdog/tests/schedule-materializer-locking.test.js"],
    agentUse: "Assign this block when changing recurring work, due triggers, or policy evolution.",
    patterns: [
      /^extensions\/watchdog\/lib\/automation\//,
      /^extensions\/watchdog\/lib\/schedule\//,
      /^extensions\/watchdog\/lib\/automation-/,
      /^extensions\/watchdog\/lib\/schedule-/,
      /^extensions\/watchdog\/lib\/automation\.js$/,
    ],
  }),
  block({
    id: "projection-ui",
    title: "Projection UI",
    purpose: "Own dashboard and visual projection without owning runtime truth.",
    ownedTruth: ["projection state", "dashboard view model", "SSE display payload"],
    interfaces: ["dashboard modules", "operator UI", "work items UI"],
    minimalTests: ["extensions/watchdog/tests/dashboard-contract-lane.test.js", "extensions/watchdog/tests/dashboard-stage-visibility.test.js"],
    agentUse: "Assign this block when changing what users see, not what the runtime decides.",
    patterns: [
      /^extensions\/watchdog\/dashboard/,
      /^extensions\/watchdog\/.*\.html$/,
      /^extensions\/watchdog\/.*\.css$/,
      /^extensions\/watchdog\/dashboard-.*\.js$/,
    ],
  }),
  block({
    id: "verification-docs",
    title: "Verification Docs",
    purpose: "Own repeatable test entrypoints, presets, reports, wiki, and implementation plans.",
    ownedTruth: ["test preset", "test report contract", "wiki concept", "implementation plan"],
    interfaces: ["test-runner CLI", "formal check report", "wiki schema"],
    minimalTests: ["extensions/watchdog/tests/test-runner-cli-client.test.js", "extensions/watchdog/tests/formal-check-runner.test.js"],
    agentUse: "Assign this block when changing verification surfaces or project knowledge, and allow it as support for other blocks.",
    support: true,
    patterns: [
      /^extensions\/watchdog\/tests\//,
      /^extensions\/qqbot\/tests\//,
      /^extensions\/watchdog\/test-runner\.js$/,
      /^extensions\/watchdog\/lib\/dev\//,
      /^extensions\/watchdog\/lib\/formal-runtime\//,
      /^extensions\/watchdog\/lib\/formal-test-/,
      /^extensions\/watchdog\/lib\/test-/,
      /^scripts\//,
      /^docs\//,
      /^wiki\//,
      /^use guide\//,
      /^AGENTS\.md$/,
      /^CLAUDE\.md$/,
      /^CODEX\.md$/,
      /^SYSTEM_MAP\.md$/,
      /^BUILDING-MAP\.md$/,
      /^README\.md$/,
    ],
  }),
]);

const BLOCKS = new Map(SYSTEM_BLOCKS.map((block) => [block.id, block]));

export function getSystemBlock(id) {
  return BLOCKS.get(String(id || "")) || null;
}

export function classifySystemBlockPath(filePath) {
  const normalizedPath = normalizePath(filePath);
  const owner = SYSTEM_BLOCKS.find((block) => block.patterns.some((pattern) => pattern.test(normalizedPath)));
  return owner?.id || null;
}

export function summarizeSystemBlockDiff({ primaryBlock, files }) {
  assertKnownBlock(primaryBlock);

  const byBlock = {};
  const unclassified = [];
  const crossBlockRuntimeFiles = [];
  for (const file of files || []) {
    const normalizedFile = normalizePath(file);
    if (!normalizedFile) {
      continue;
    }
    const blockId = classifySystemBlockPath(normalizedFile);
    if (!blockId) {
      unclassified.push(normalizedFile);
      continue;
    }
    byBlock[blockId] ||= [];
    byBlock[blockId].push(normalizedFile);
    if (blockId !== primaryBlock && !getSystemBlock(blockId)?.support) {
      crossBlockRuntimeFiles.push(normalizedFile);
    }
  }

  return {
    primaryBlock,
    byBlock,
    unclassified,
    crossBlockRuntimeFiles,
    touchedRuntimeBlocks: Object.keys(byBlock).filter((blockId) => !getSystemBlock(blockId)?.support),
  };
}

export function buildSystemBlockReport({ primaryBlock, files }) {
  const problems = [];
  if (!getSystemBlock(primaryBlock)) {
    return {
      ok: false,
      primaryBlock,
      summary: null,
      problems: [`unknown primary block: ${primaryBlock}`],
    };
  }

  const summary = summarizeSystemBlockDiff({ primaryBlock, files });
  for (const file of summary.crossBlockRuntimeFiles) {
    problems.push(`cross-block runtime edit for ${primaryBlock}: ${file}`);
  }
  if (summary.touchedRuntimeBlocks.length >= 3) {
    problems.push(`edits touch ${summary.touchedRuntimeBlocks.length} non-support blocks; split this task before implementation`);
  }

  return {
    ok: problems.length === 0,
    primaryBlock,
    summary,
    problems,
  };
}

export function parseGitStatusPath(line) {
  const raw = String(line || "");
  if (!raw.trim()) {
    return null;
  }
  const payload = raw.length >= 3 ? raw.slice(3).trim() : raw.trim();
  const renamed = payload.match(/^(.+) -> (.+)$/);
  return renamed ? renamed[2] : payload || null;
}

function block(definition) {
  return Object.freeze({
    support: false,
    ...definition,
    patterns: Object.freeze(definition.patterns || []),
    ownedTruth: Object.freeze(definition.ownedTruth || []),
    interfaces: Object.freeze(definition.interfaces || []),
    minimalTests: Object.freeze(definition.minimalTests || []),
  });
}

function assertKnownBlock(primaryBlock) {
  if (!getSystemBlock(primaryBlock)) {
    throw new Error(`unknown primary block: ${primaryBlock}`);
  }
}

function normalizePath(filePath) {
  return String(filePath || "").split(sep).join("/").replace(/^\.\//, "");
}
