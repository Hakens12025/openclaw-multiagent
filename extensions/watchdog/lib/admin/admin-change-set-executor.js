import {
  getAdminChangeSetDetails,
  recordAdminChangeSetExecution,
} from "./admin-change-sets.js";
import {
  CommitVerificationBlockedError,
  evaluateCommitVerificationGate,
} from "./admin-change-set-commit-gate.js";
import { makeExecutionId } from "./admin-change-set-history.js";
import {
  buildAdminChangeSetPreview,
  resolveAdminChangeSetVerificationRequest,
} from "./admin-change-set-preview.js";
import { executeAdminSurfaceOperation } from "./admin-surface-operations.js";
import { normalizeRecord } from "../core/normalize.js";

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
  requireVerification = true,
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
    const finishedAt = Date.now();
    const recorded = await recordAdminChangeSetExecution({
      id: draft.id,
      executionId,
      surfaceId: preview.surfaceId,
      dryRun: true,
      status: "completed",
      executionStatus: "previewed",
      startedAt,
      finishedAt,
      durationMs: finishedAt - startedAt,
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

    // 强制 verify 门（代码硬路径）：apply 已发生，但 commit-to-applied 前必须
    // 已有一条 passed 的 verification 记录（复用既有 verificationHistory 字段链）。
    // 不过门 -> 不记 applied，改记 verification_blocked 并抛错，commit 被硬拦。
    const commitGate = evaluateCommitVerificationGate({ draft, preview, requireVerification });
    if (commitGate.required && !commitGate.passed) {
      const blockedAt = Date.now();
      // ⑩ The apply ALREADY mutated the system; when the commit-verification gate blocks, roll the
      // structural change back (reuse the pre-apply snapshot the choke captured) so a blocked change-set
      // never leaves a half-applied mutation. Non-structural surfaces have no snapshot → nothing to undo.
      const rollback = normalizedResult.preApplySnapshot
        ? await (await import("../control-plane/structure-snapshot.js"))
            .restoreStructureSnapshot(normalizedResult.preApplySnapshot)
            .catch((e) => ({ ok: false, error: e.message }))
        : { ok: false, error: "no pre-apply snapshot captured (non-structural surface)" };
      await recordAdminChangeSetExecution({
        id: draft.id,
        executionId,
        surfaceId: preview.surfaceId,
        dryRun: false,
        status: "failed",
        executionStatus: "verification_blocked",
        startedAt,
        finishedAt: blockedAt,
        durationMs: blockedAt - startedAt,
        payload: preview.payload,
        managementContext: preview.managementContext,
        result: { ...normalizedResult, commitGate, rollback },
        error: commitGate.reason,
      });
      throw new CommitVerificationBlockedError(preview.surfaceId, commitGate);
    }

    let verification = null;
    let verificationWarning = null;
    if (verificationRequest) {
      try {
        const verificationResult = await executeAdminSurfaceOperation({
          surfaceId: "test_runs.start",
          payload: {
            presetId: verificationRequest.presetId,
            cleanMode: verificationRequest.cleanMode,
          },
          logger,
          onAlert,
          runtimeContext: effectiveRuntimeContext,
        });
        verification = {
          kind: verificationRequest.kind,
          status: "started",
          presetId: verificationRequest.presetId,
          cleanMode: verificationRequest.cleanMode,
          run: verificationResult.run,
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
    // 门拦截已自记 verification_blocked，直接上抛，避免重复记录。
    if (error instanceof CommitVerificationBlockedError) {
      throw error;
    }
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
