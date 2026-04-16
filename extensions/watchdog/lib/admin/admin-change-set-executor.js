import {
  getAdminChangeSetDetails,
  recordAdminChangeSetExecution,
} from "./admin-change-sets.js";
import { makeExecutionId } from "./admin-change-set-history.js";
import {
  buildAdminChangeSetPreview,
  resolveAdminChangeSetVerificationRequest,
} from "./admin-change-set-preview.js";
import { executeAdminSurfaceOperation } from "./admin-surface-operations.js";
import { normalizeRecord } from "../core/normalize.js";
import { startTestRun } from "../test-runs.js";

export async function previewAdminChangeSetExecution({ id }) {
  const draft = await getAdminChangeSetDetails(id);
  if (!draft) {
    throw new Error(`draft not found: ${id}`);
  }

  const preview = buildAdminChangeSetPreview(draft);
  return {
    draft,
    preview,
  };
}

export async function executeAdminChangeSet({
  id,
  dryRun = false,
  startVerification = false,
  explicitConfirm = false,
  logger = null,
  onAlert = null,
  runtimeContext = null,
}) {
  const { draft, preview } = await previewAdminChangeSetExecution({ id });
  if (!preview.supported) {
    throw new Error(`surface not yet executable: ${preview.surfaceId}`);
  }
  if (preview.confirmation === "explicit" && explicitConfirm !== true) {
    throw new Error(`surface requires explicit confirmation: ${preview.surfaceId}`);
  }
  if (!preview.ready) {
    throw new Error(`missing required payload fields: ${preview.missingFields.map((field) => field.key).join(", ")}`);
  }
  const verificationRequest = resolveAdminChangeSetVerificationRequest(draft, preview, { startVerification });
  const executionId = makeExecutionId();

  const effectiveRuntimeContext = {
    ...(runtimeContext || {}),
    originDraftId: draft.id,
    originExecutionId: executionId,
    originSurfaceId: preview.surfaceId,
  };

  const startedAt = Date.now();
  if (dryRun) {
    const recorded = await recordAdminChangeSetExecution({
      id: draft.id,
      executionId,
      surfaceId: preview.surfaceId,
      dryRun: true,
      status: "completed",
      executionStatus: "previewed",
      startedAt,
      finishedAt: Date.now(),
      durationMs: Date.now() - startedAt,
      payload: preview.payload,
      managementContext: preview.managementContext,
      result: {
        request: preview.request,
        note: "preview only",
      },
    });
    return {
      draft: recorded.draft,
      executionRecord: recorded.executionRecord,
      preview,
      result: recorded.executionRecord.result,
    };
  }

  try {
    const result = await executeAdminSurfaceOperation({
      surfaceId: preview.surfaceId,
      payload: preview.payload,
      logger,
      onAlert,
      runtimeContext: effectiveRuntimeContext,
    });
    const normalizedResult = normalizeRecord(result);
    let verification = null;
    let verificationWarning = null;
    if (verificationRequest) {
      try {
        const run = startTestRun({
          presetId: verificationRequest.presetId,
          cleanMode: verificationRequest.cleanMode,
          originDraftId: draft.id,
          originExecutionId: executionId,
          originSurfaceId: preview.surfaceId,
          runtimeContext: effectiveRuntimeContext,
        }, logger);
        verification = {
          kind: verificationRequest.kind,
          status: "started",
          presetId: verificationRequest.presetId,
          cleanMode: verificationRequest.cleanMode,
          run,
        };
      } catch (error) {
        verification = {
          kind: verificationRequest.kind,
          status: "failed_to_start",
          presetId: verificationRequest.presetId,
          cleanMode: verificationRequest.cleanMode,
          error: error.message,
        };
        verificationWarning = error.message;
      }
    }
    if (verification) {
      normalizedResult.verification = verification;
    }
    const finishedAt = Date.now();
    const recorded = await recordAdminChangeSetExecution({
      id: draft.id,
      executionId,
      surfaceId: preview.surfaceId,
      dryRun: false,
      status: "completed",
      executionStatus: "applied",
      startedAt,
      finishedAt,
      durationMs: finishedAt - startedAt,
      payload: preview.payload,
      managementContext: preview.managementContext,
      result: normalizedResult,
    });
    return {
      draft: recorded.draft,
      executionRecord: recorded.executionRecord,
      preview,
      result: normalizedResult,
      verification,
      verificationWarning,
    };
  } catch (error) {
    const finishedAt = Date.now();
    await recordAdminChangeSetExecution({
      id: draft.id,
      executionId,
      surfaceId: preview.surfaceId,
      dryRun: false,
      status: "failed",
      executionStatus: "failed",
      startedAt,
      finishedAt,
      durationMs: finishedAt - startedAt,
      payload: preview.payload,
      managementContext: preview.managementContext,
      error: error.message,
    });
    throw error;
  }
}
