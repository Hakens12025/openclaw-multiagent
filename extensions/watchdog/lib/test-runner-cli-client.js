const TERMINAL_RUN_STATUSES = new Set(["completed", "failed"]);

function normalizePresetList(payload) {
  if (Array.isArray(payload)) return payload;
  return Array.isArray(payload?.presets) ? payload.presets : [];
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
