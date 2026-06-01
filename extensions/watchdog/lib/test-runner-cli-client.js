const TERMINAL_RUN_STATUSES = new Set(["completed", "failed"]);
const CLI_MIN_TIMEOUT_MS = 300000;
const CLI_SINGLE_CASE_BUDGET_MS = 360000;
const CLI_CONCURRENT_CASE_BUDGET_MS = 420000;
const CLI_RUNTIME_CASE_BUDGET_MS = 360000;
const CLI_RESET_ALLOWANCE_MS = 45000;
const CLI_FINALIZATION_ALLOWANCE_MS = 120000;
const RETIRED_CLI_FLAGS = new Set(["--suite", "--filter", "--clean"]);
const SUPPORTED_CLI_FLAGS = new Set(["--preset", "--case"]);

function normalizePresetList(payload) {
  if (Array.isArray(payload)) return payload;
  return Array.isArray(payload?.presets) ? payload.presets : [];
}

export function normalizeCliRunTarget({ presetId = "", caseId = "" } = {}) {
  const normalizedPresetId = String(presetId || "").trim();
  const normalizedCaseId = String(caseId || "").trim();
  if (normalizedPresetId && normalizedCaseId) {
    throw new Error("provide either --preset or --case, not both");
  }
  if (normalizedCaseId) {
    return { mode: "case", caseId: normalizedCaseId };
  }
  return { mode: "preset", presetId: normalizedPresetId || "single" };
}

export function parseCliRunArgs(argv = []) {
  const args = Array.isArray(argv) ? argv.slice(2) : [];
  const parsed = {
    presetId: "",
    caseId: "",
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
  const perCaseBudgetMs = preset?.suite === "concurrent"
    ? CLI_CONCURRENT_CASE_BUDGET_MS
    : preset?.suite === "direct-service"
      ? CLI_RUNTIME_CASE_BUDGET_MS
      : CLI_SINGLE_CASE_BUDGET_MS;
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
