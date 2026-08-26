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
      /^extensions\/watchdog\/lib\/contract\//,
      /^extensions\/watchdog\/lib\/protocol\//,
      /^extensions\/watchdog\/lib\/session\/(?!session-bootstrap\.js$)/,
      /^extensions\/watchdog\/lib\/control-plane\//,
      /^extensions\/watchdog\/lib\/evidence\//,
      /^extensions\/watchdog\/lib\/store\//,
      /^extensions\/watchdog\/lib\/core\//,
      /^extensions\/watchdog\/lib\/state/,
      /^extensions\/watchdog\/lib\/[^/]*ledger[^/]*\.js$/,
      /^extensions\/watchdog\/lib\/protocol-/,
      /^extensions\/watchdog\/lib\/[^/]*lease[^/]*\.js$/,
      /^extensions\/watchdog\/lib\/runtime-activity\.js$/,
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
      /^extensions\/watchdog\/lib\/delivery/,
      /^extensions\/watchdog\/routes\//,
      /^extensions\/qqbot\//,
      /^extensions\/watchdog\/lib\/routing\/qq-reply-target\.js$/,
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
      /^extensions\/watchdog\/lib\/agent\/(?!agent-graph)/,
      /^extensions\/watchdog\/lib\/prompt\//,
      /^extensions\/watchdog\/lib\/session\/session-bootstrap\.js$/,
      /^extensions\/watchdog\/lib\/security\/capability-preset-registry\.js$/,
      /^extensions\/watchdog\/lib\/security\/execution-policy-defaults\.js$/,
      /^extensions\/watchdog\/lib\/effective-profile-composer\.js$/,
      /^extensions\/watchdog\/lib\/workspace-guidance-/,
      /^extensions\/watchdog\/lib\/llm\/brain-model-resolver\.js$/,
      /^extensions\/watchdog\/lib\/llm\/llm-planner\.js$/,
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
      /^extensions\/watchdog\/lib\/security\//,
      /^extensions\/watchdog\/lib\/stage\/io-observation\.js$/,
      /^extensions\/watchdog\/lib\/stage\/execution-observation\.js$/,
      /^extensions\/watchdog\/lib\/heartbeat-gate\.js$/,
      /^extensions\/watchdog\/lib\/tool-/,
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
      /^extensions\/watchdog\/lib\/agent\/agent-graph/,
    ],
  }),
  block({
    id: "stage",
    title: "Stage",
    purpose: "Own task stage planning, stage run results, and stage projection truth.",
    ownedTruth: ["stage plan", "stage runtime", "stage result", "stage projection"],
    interfaces: ["task stage plan API", "stage result normalizer", "stage projection API"],
    minimalTests: ["extensions/watchdog/tests/task-stage-plan.test.js", "extensions/watchdog/tests/stage-projection.test.js"],
    agentUse: "Assign this block when changing task stage plans, stage advancement, or stage projection.",
    patterns: [
      /^extensions\/watchdog\/lib\/stage\//,
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
      /^extensions\/watchdog\/lib\/cli-/,
      /^extensions\/watchdog\/lib\/system-action\//,
      /^extensions\/watchdog\/lib\/admin\//,
      /^extensions\/watchdog\/lib\/management\//,
      /^extensions\/watchdog\/lib\/viz\//,
      /^extensions\/watchdog\/lib\/knowledge\//,
      /^extensions\/watchdog\/routes\/operator-/,
      /^extensions\/watchdog\/routes\/admin-/,
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
    ],
  }),
  block({
    id: "projection-ui",
    title: "Projection UI",
    purpose: "Own dashboard and visual projection without owning runtime truth.",
    ownedTruth: ["projection state", "dashboard view model", "SSE display payload"],
    interfaces: ["dashboard modules", "operator UI", "work items UI"],
    minimalTests: ["extensions/watchdog/tests/ui-router.test.js", "extensions/watchdog/tests/ui-store.test.js"],
    agentUse: "Assign this block when changing what users see, not what the runtime decides.",
    patterns: [
      /^extensions\/watchdog\/ui\//,
      /^extensions\/watchdog\/.*\.html$/,
      /^extensions\/watchdog\/.*\.css$/,
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
