// control-plane-paths.js — single location authority for runtime-owned
// control-plane stores. Runtime-owned state lives under ~/.openclaw/control-plane/
// so it doesn't share the workspaces/ tree with agent-authored workspaces.
//
// Self-contained: does not import from state-paths.js to avoid a cycle
// (state-paths re-exports CONTRACTS_DIR / STATE_FILE / QUEUE_STATE_FILE
// from here for back-compat with the existing 5 consumers).

import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const OC_ROOT = join(homedir(), ".openclaw");

export const CONTROL_PLANE_ROOT = join(OC_ROOT, "control-plane");

// ── 店根门卫(核心设计指标§13「多主体真值:写者身份进门」,备忘录158 §五) ──
// node:test 给每个测试子进程恒注入 NODE_TEST_CONTEXT(实测 child-v8)。测试进程
// 未显式种子(OPENCLAW_* env)时,店根一律落进程级 mkdtemp 沙箱——手跑单测
// (五次生产树污染事故的全部通道,最近一次 2026-08-26 TC-TERMINALIZE 夹具)从此
// 结构性免疫,忘不忘导 seed-tree-stores 都污染不了生产。npm test 的显式 env 照旧
// 生效;网关/live 预设/CLI 脚本无 NODE_TEST_CONTEXT,生产根不变。
// seed-tree-stores 由"安全边界"降格为"确定性夹具工具"。
// 判定属主唯一在此;各店解析函数只消费本函数,不得各自另判。
let testSandboxRoot = null;
export function resolveOwnedStorePath(envKey, productionPath, sandboxRel) {
  const seeded = process.env[envKey];
  if (typeof seeded === "string" && seeded.trim()) return seeded.trim();
  if (process.env.NODE_TEST_CONTEXT) {
    if (!testSandboxRoot) testSandboxRoot = mkdtempSync(join(tmpdir(), "openclaw-teststore-"));
    return join(testSandboxRoot, sandboxRel);
  }
  return productionPath;
}

export const CONTROL_PLANE_PATHS = Object.freeze({
  root: CONTROL_PLANE_ROOT,
  contractsDir: join(CONTROL_PLANE_ROOT, "contracts"),
  threadsDir: join(CONTROL_PLANE_ROOT, "threads"), // 批②树店根(备忘录142 §三);IO 时经 OPENCLAW_THREADS_DIR 惰性种子,见 lib/archive/thread-tree-store.js
  contractIndexFile: join(CONTROL_PLANE_ROOT, "contract-index.jsonl"), // id→{threadId,runId} append-only 索引;种子 OPENCLAW_CONTRACT_INDEX_FILE
  sessionIndexFile: join(CONTROL_PLANE_ROOT, "session-index.jsonl"), // 会话 id→run 家 append-only 索引;种子 OPENCLAW_SESSION_INDEX_FILE,见 lib/archive/session-home-index.js
  traceDir: join(CONTROL_PLANE_ROOT, "trace"), // session event ledger（与已退场的 workflow-trace 快照店无关）

  stateFile: join(CONTROL_PLANE_ROOT, "watchdog-state.json"),
  queueStateFile: join(CONTROL_PLANE_ROOT, "queue-state.json"),
  outputDir: join(CONTROL_PLANE_ROOT, "output"),
  adminChangeSetsDir: join(CONTROL_PLANE_ROOT, "admin-change-sets"),
  taskStateFile: join(CONTROL_PLANE_ROOT, "task-state.md"),
  systemActionDeliveryTicketsFile: join(CONTROL_PLANE_ROOT, "system-action-delivery-tickets.json"),
  agentDefaultSkillsFile: join(CONTROL_PLANE_ROOT, "agent-default-skills.json"),
  agentJoinRegistryFile: join(CONTROL_PLANE_ROOT, "agent-join-registry.json"),
  agentGraphFile: join(CONTROL_PLANE_ROOT, "agent-graph.json"),
  automationRuntimeFile: join(CONTROL_PLANE_ROOT, "automation-runtime.json"),
  automationRegistryFile: join(CONTROL_PLANE_ROOT, "automation-registry.json"),
  scheduleRegistryFile: join(CONTROL_PLANE_ROOT, "schedule-registry.json"),
  scheduleMaterializerFile: join(CONTROL_PLANE_ROOT, "schedule-materializer.json"),
  guidanceDriftStateFile: join(CONTROL_PLANE_ROOT, "guidance-drift-state.json"),
  migrationStateFile: join(CONTROL_PLANE_ROOT, "control-plane-migration-state.json"),
  structureSnapshotsFile: join(CONTROL_PLANE_ROOT, "structure-snapshots.json"),
  knowledgeBasesFile: join(CONTROL_PLANE_ROOT, "knowledge-bases.json"),
  chartsRegistryFile: join(CONTROL_PLANE_ROOT, "charts.json"),
  knowledgeEvalSetsFile: join(CONTROL_PLANE_ROOT, "knowledge-eval-sets.json"),
  knowledgeEvalRunsFile: join(CONTROL_PLANE_ROOT, "knowledge-eval-runs.json"),
  // .jsonl(append-only 键账,delivery-idempotency-store):追加写,不整文件重写
  deliveryIdempotencyFile: join(CONTROL_PLANE_ROOT, "delivery-idempotency.jsonl"),
  // 单文件一票(delivery-ticket-store):dlv-{contractId}.json,泵消费后删除
  deliveryTicketsDir: join(CONTROL_PLANE_ROOT, "delivery-tickets"),
});

// per-KB RAG 索引文件:control-plane/kb-<id>-index.json(wiki 库例外,复用 wiki-rag-index.json)。
// id 经 charset 白名单防路径穿越(sources 由用户/operator 提供)。
export function knowledgeBaseIndexFile(kbId) {
  const safe = String(kbId || "").replace(/[^a-z0-9_-]/gi, "");
  if (!safe) throw new Error("invalid knowledge base id");
  return join(CONTROL_PLANE_ROOT, `kb-${safe}-index.json`);
}

// Legacy controller-workspace mirrors; used only by the one-shot boot-time
// migration helper (see control-plane-migrate.js) to lift data from the
// pre-v5.1 location. Values are NOT derivable from CONTROL_PLANE_PATHS — the
// legacy filenames are irregular (dot-prefixed, snake_case, CamelCase).
export const LEGACY_CONTROLLER_ROOT = join(OC_ROOT, "workspaces", "controller");
export const LEGACY_CONTROLLER_PATHS = Object.freeze({
  contractsDir: join(LEGACY_CONTROLLER_ROOT, "contracts"),
  stateFile: join(LEGACY_CONTROLLER_ROOT, ".watchdog-state.json"),
  queueStateFile: join(LEGACY_CONTROLLER_ROOT, ".queue-state.json"),
  outputDir: join(LEGACY_CONTROLLER_ROOT, "output"),
  adminChangeSetsDir: join(LEGACY_CONTROLLER_ROOT, "admin-change-sets"),
  taskStateFile: join(LEGACY_CONTROLLER_ROOT, "TASK_STATE.md"),
  systemActionDeliveryTicketsFile: join(LEGACY_CONTROLLER_ROOT, ".system-action-delivery-tickets.json"),
  agentDefaultSkillsFile: join(LEGACY_CONTROLLER_ROOT, ".agent-default-skills.json"),
  agentJoinRegistryFile: join(LEGACY_CONTROLLER_ROOT, ".watchdog-agent-joins.json"),
  agentGraphFile: join(LEGACY_CONTROLLER_ROOT, "agent_graph.json"),
  automationRuntimeFile: join(LEGACY_CONTROLLER_ROOT, ".watchdog-automation-runtime.json"),
  automationRegistryFile: join(LEGACY_CONTROLLER_ROOT, ".watchdog-automations.json"),
  scheduleRegistryFile: join(LEGACY_CONTROLLER_ROOT, ".watchdog-schedules.json"),
  scheduleMaterializerFile: join(LEGACY_CONTROLLER_ROOT, ".watchdog-schedule-materializer.json"),
  guidanceDriftStateFile: join(LEGACY_CONTROLLER_ROOT, ".guidance-drift-state.json"),
});
