// lib/formal-runtime/test-runner-cli-client.js — test-runner CLI 纯逻辑（参数解析/超时预算/轮询/展示）
// 预设真值在 live surface（GET /watchdog/test-runs），CLI 不写死 preset id。

const TERMINAL_RUN_STATUSES = new Set(["completed", "failed"]);
const CLI_MIN_TIMEOUT_MS = 300000;
const CLI_RESET_ALLOWANCE_MS = 45000;
const CLI_FINALIZATION_ALLOWANCE_MS = 120000;
const RETIRED_CLI_FLAGS = new Set(["--suite", "--filter", "--clean"]);
const SUPPORTED_CLI_FLAGS = new Set(["--preset", "--case", "--list", "--help"]);
const DEFAULT_CLI_PRESET_ID = "health";

// 每 suite 的单 case 时间预算：health/knowledge/operator 零或少 LLM（快），
// single/concurrent/pipeline/collab/model 走 live LLM 链路（慢），
// full 按段计费。
// concurrent 的 420s = 单 case 观测窗 300s + fullReset/释放对账余量。
// model 的 1260s = 有凭证 provider 串行 worst-case（≈6 ×（API 腿 4 格式并行 20s +
// e2e 180s）≈ 20min；caseIds=[] → caseCount=1，预算即整套上限）。
// unit 的 660s = npm test spawn 硬超时 600s（suite-unit.js）+ totals 解析/graph 写回余量。
const SUITE_CASE_BUDGET_MS = Object.freeze({
  health: 120000,
  knowledge: 180000,
  operator: 300000,
  single: 360000,
  concurrent: 420000,
  pipeline: 480000,
  collab: 480000,
  model: 1260000,
  unit: 660000,
  full: 600000,
});
const DEFAULT_CASE_BUDGET_MS = 360000;

export const CLI_USAGE = `OpenClaw Test Runner — /watchdog/test-runs/* 薄客户端

用法:
  node test-runner.js [--preset <id>] [--case <id>] [--list] [--help]

  (无参数)        运行默认预设 "${DEFAULT_CLI_PRESET_ID}"（零 LLM 系统体检）
  --preset <id>   运行指定预设（用 --list 查看 live 预设表）
  --case <id>     单用例 ad-hoc 运行（仅支持 single/pipeline 的 case id）
  --list          打印 live 预设表后退出
  --help          打印本说明后退出

退出码: 0 = 全部通过 | 1 = 有 fail | 2 = 有 blocked
报告: ~/.openclaw/test-reports/devtool-<presetId>-<ts>.txt (+.json 机器可读镜像)
已退役的旗标 --suite/--filter/--clean 会硬报错。`;

function normalizePresetList(payload) {
  if (Array.isArray(payload)) return payload;
  return Array.isArray(payload?.presets) ? payload.presets : [];
}

export function normalizeCliRunTarget({ presetId = "", caseId = "", list = false, help = false } = {}) {
  if (help) return { mode: "help" };
  if (list) return { mode: "list" };
  const normalizedPresetId = String(presetId || "").trim();
  const normalizedCaseId = String(caseId || "").trim();
  if (normalizedPresetId && normalizedCaseId) {
    throw new Error("provide either --preset or --case, not both");
  }
  if (normalizedCaseId) {
    return { mode: "case", caseId: normalizedCaseId };
  }
  return { mode: "preset", presetId: normalizedPresetId || DEFAULT_CLI_PRESET_ID };
}

export function parseCliRunArgs(argv = []) {
  const args = Array.isArray(argv) ? argv.slice(2) : [];
  const parsed = {
    presetId: "",
    caseId: "",
    list: false,
    help: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!String(arg || "").startsWith("--")) {
      throw new Error(`unexpected CLI argument: ${arg}`);
    }
    if (RETIRED_CLI_FLAGS.has(arg)) {
      throw new Error(`retired CLI flag: ${arg}`);
    }
    if (!SUPPORTED_CLI_FLAGS.has(arg)) {
      throw new Error(`unknown CLI flag: ${arg}`);
    }
    if (arg === "--list") {
      parsed.list = true;
      continue;
    }
    if (arg === "--help") {
      parsed.help = true;
      continue;
    }
    const value = args[index + 1];
    if (!value || String(value).startsWith("--")) {
      throw new Error(`missing value for ${arg}`);
    }
    if (arg === "--preset") parsed.presetId = value;
    if (arg === "--case") parsed.caseId = value;
    index += 1;
  }

  return parsed;
}

export function findCliPreset(payload, presetId) {
  const normalizedPresetId = String(presetId || "").trim();
  if (!normalizedPresetId) return null;
  return normalizePresetList(payload)
    .find((preset) => String(preset?.id || "").trim() === normalizedPresetId) || null;
}

// --list 的纯渲染（live surface payload → 对齐文本表）。
export function formatCliPresetTable(payload) {
  const presets = normalizePresetList(payload);
  if (presets.length === 0) return "(no presets exposed by gateway)";
  const rows = presets.map((preset) => ({
    id: String(preset?.id || "--"),
    suite: String(preset?.suite || "--"),
    cleanMode: String(preset?.cleanMode || "--"),
    cases: Array.isArray(preset?.caseIds) && preset.caseIds.length ? preset.caseIds.join(",") : "--",
    label: String(preset?.label || ""),
    description: String(preset?.description || ""),
  }));
  const idWidth = Math.max(6, ...rows.map((row) => row.id.length));
  const suiteWidth = Math.max(5, ...rows.map((row) => row.suite.length));
  const cleanWidth = Math.max(9, ...rows.map((row) => row.cleanMode.length));
  const lines = [
    `${"PRESET".padEnd(idWidth)}  ${"SUITE".padEnd(suiteWidth)}  ${"CLEANMODE".padEnd(cleanWidth)}  DESCRIPTION`,
  ];
  for (const row of rows) {
    const summary = row.label ? `${row.label} — ${row.description}` : row.description;
    lines.push(`${row.id.padEnd(idWidth)}  ${row.suite.padEnd(suiteWidth)}  ${row.cleanMode.padEnd(cleanWidth)}  ${summary}`);
    if (row.cases !== "--") {
      lines.push(`${"".padEnd(idWidth)}  ${"".padEnd(suiteWidth)}  ${"".padEnd(cleanWidth)}  cases: ${row.cases}`);
    }
  }
  return lines.join("\n");
}

export function resolveCliRunExitCode(detail) {
  const failedCases = Number(detail?.failedCases || 0);
  const blockedCases = Number(detail?.blockedCases || 0);
  if (failedCases > 0) return 1;
  if (blockedCases > 0) return 2;
  return 0;
}

export function estimateCliRunTimeoutMs(preset) {
  const caseCount = Array.isArray(preset?.caseIds) && preset.caseIds.length > 0
    ? preset.caseIds.length
    : 1;
  const perCaseBudgetMs = SUITE_CASE_BUDGET_MS[preset?.suite] ?? DEFAULT_CASE_BUDGET_MS;
  const resetAllowanceMs = preset?.resetBetweenCases === true
    ? Math.max(0, caseCount - 1) * CLI_RESET_ALLOWANCE_MS
    : 0;
  return Math.max(
    CLI_MIN_TIMEOUT_MS,
    (caseCount * perCaseBudgetMs) + resetAllowanceMs + CLI_FINALIZATION_ALLOWANCE_MS,
  );
}

export async function waitForCliRunCompletion({
  runId,
  requestJSON,
  sleep,
  pollIntervalMs = 1500,
  timeoutMs = 300000,
  onProgress = null,
}) {
  if (typeof requestJSON !== "function") {
    throw new TypeError("waitForCliRunCompletion requires requestJSON");
  }
  if (typeof sleep !== "function") {
    throw new TypeError("waitForCliRunCompletion requires sleep");
  }

  const normalizedRunId = String(runId || "").trim();
  if (!normalizedRunId) {
    throw new TypeError("waitForCliRunCompletion requires runId");
  }

  const deadline = Date.now() + timeoutMs;
  let lastFingerprint = null;

  while (Date.now() < deadline) {
    const detail = await requestJSON(`/watchdog/test-runs/detail?id=${encodeURIComponent(normalizedRunId)}`);
    const fingerprint = [
      detail?.status || "",
      detail?.currentCaseId || "",
      detail?.completedCases || 0,
      detail?.passedCases || 0,
      detail?.failedCases || 0,
      detail?.blockedCases || 0,
    ].join("|");

    if (fingerprint !== lastFingerprint) {
      lastFingerprint = fingerprint;
      if (typeof onProgress === "function") {
        onProgress(detail);
      }
    }

    if (TERMINAL_RUN_STATUSES.has(String(detail?.status || ""))) {
      return detail;
    }

    await sleep(pollIntervalMs);
  }

  throw new Error(`timeout waiting for test run ${normalizedRunId}`);
}
