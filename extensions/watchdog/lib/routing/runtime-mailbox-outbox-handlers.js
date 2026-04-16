// lib/runtime-mailbox-outbox-handlers.js — role-specific outbox protocol handlers

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { evictContractSnapshotByPath } from "../store/contract-store.js";
import { getContractPath, mutateContractSnapshot } from "../contracts.js";
import { CONTRACT_STATUS } from "../core/runtime-status.js";
import { ARTIFACT_TYPES } from "../protocol-primitives.js";
import { buildReviewerResult } from "../harness/reviewer-result.js";
import {
  normalizeStageRunResult,
} from "../stage-results.js";
import {
  materializeTaskStagePlan,
  deriveCompatibilityPhases,
  deriveCompatibilityTotal,
} from "../task-stage-plan.js";
import {
  OUTPUT_DIR,
  removeFileQuietly,
  findManifestArtifactFile,
  listManifestArtifactFiles,
  readActiveInboxContract,
  buildStageDefaults,
  buildImplicitTextOutputStageRunResult,
  materializeOutboxArtifacts,
  remapStageRunArtifacts,
  buildCompletedStageCompletion,
  buildHoldStageCompletion,
  collectExplicitStageResult,
  normalizeObservedStageRunResult,
} from "./runtime-mailbox-outbox-helpers.js";
import {
  normalizeReviewerDecision,
  buildReviewerTransition,
} from "./runtime-mailbox-outbox-reviewer-verdict.js";

export async function collectWorkerOutbox({ agentId, outboxDir, files, logger, manifest }) {
  const activeContract = await readActiveInboxContract(agentId);
  const explicitStageResult = await collectExplicitStageResult({
    agentId,
    outboxDir,
    files,
    logger,
    manifest,
    activeContract,
  });
  if (explicitStageResult) {
    return explicitStageResult;
  }

  let contractResult = null;
  const resultFile = findManifestArtifactFile(manifest, ARTIFACT_TYPES.CONTRACT_RESULT, files, ["contract_result.json"]);
  if (resultFile) {
    try {
      const raw = await readFile(join(outboxDir, resultFile), "utf8");
      const parsed = JSON.parse(raw);
      if ([
        CONTRACT_STATUS.COMPLETED,
        CONTRACT_STATUS.FAILED,
        CONTRACT_STATUS.AWAITING_INPUT,
      ].includes(parsed.status)) {
        contractResult = parsed;
        logger.info(`[router] collectOutbox(worker): contract_result.json (${parsed.status})`);
      } else {
        logger.warn(`[router] collectOutbox(worker): invalid contract_result status "${parsed.status}"`);
      }
    } catch (error) {
      logger.warn(`[router] collectOutbox(worker): contract_result parse error: ${error.message}`);
    } finally {
      await removeFileQuietly(join(outboxDir, resultFile));
    }
  }

  const mdFiles = listManifestArtifactFiles(
    manifest,
    ARTIFACT_TYPES.TEXT_OUTPUT,
    files,
    (fileName) => fileName.endsWith(".md"),
  );
  if (mdFiles.length === 0 && !contractResult) {
    logger.warn(`[router] collectOutbox(worker): no .md files in outbox`);
    return { collected: false };
  }

  const primaryOutputFile = mdFiles[0] || null;
  const defaultOutputPath = typeof activeContract?.output === "string" && activeContract.output.trim()
    ? activeContract.output.trim()
    : null;
  const materialized = await materializeOutboxArtifacts({
    outboxDir,
    fileNames: mdFiles,
    logger,
    primaryFileName: primaryOutputFile,
    mirrorOutputPath: defaultOutputPath,
  });
  const terminalStatus = contractResult?.status === CONTRACT_STATUS.FAILED
    ? "failed"
    : contractResult?.status === CONTRACT_STATUS.AWAITING_INPUT
      ? "awaiting_input"
      : "completed";
  const summary = contractResult?.summary
    || contractResult?.detail
    || (materialized.collected.length > 0
      ? `${materialized.collected.length} output file(s) collected`
      : "worker stage completed");
  const feedback = contractResult?.detail || contractResult?.summary || summary;
  const stageRunResult = terminalStatus === "completed"
    ? buildImplicitTextOutputStageRunResult({
        activeContract,
        agentId,
        artifactPaths: materialized.collected.map(
          (fileName) => materialized.pathByFile.get(fileName) || join(OUTPUT_DIR, fileName),
        ),
        primaryOutputPath: materialized.primaryArtifactPath,
        summary,
        feedback,
      })
    : normalizeObservedStageRunResult(normalizeStageRunResult({
        ...buildStageDefaults(activeContract, agentId),
        status: terminalStatus,
        summary,
        feedback,
        artifacts: materialized.collected.map((fileName) => ({
          type: ARTIFACT_TYPES.TEXT_OUTPUT,
          path: materialized.pathByFile.get(fileName) || join(OUTPUT_DIR, fileName),
          label: fileName,
          required: true,
          primary: fileName === primaryOutputFile,
        })),
        primaryArtifactPath: materialized.primaryArtifactPath,
        completion: buildHoldStageCompletion(terminalStatus, feedback),
      }));

  return {
    collected: materialized.collected.length > 0 || !!contractResult,
    files: materialized.collected,
    artifactPaths: stageRunResult?.artifacts.map((artifact) => artifact.path) || [],
    primaryOutputPath: stageRunResult?.primaryArtifactPath || null,
    contractResult,
    stageRunResult,
    stageCompletion: stageRunResult?.completion || null,
  };
}

export async function collectReviewerOutbox({ agentId, outboxDir, files, logger, manifest }) {
  const activeContract = await readActiveInboxContract(agentId);
  const explicitStageResult = await collectExplicitStageResult({
    agentId,
    outboxDir,
    files,
    logger,
    manifest,
    activeContract,
  });
  if (explicitStageResult) {
    return explicitStageResult;
  }

  const defaults = buildStageDefaults(activeContract, agentId);
  const notes = listManifestArtifactFiles(
    manifest,
    ARTIFACT_TYPES.NOTES,
    files,
    (fileName) => fileName === "evaluation.md",
  );

  // Unified file lookup: evaluation_result > code_verdict > next_action
  const decisionFile = findManifestArtifactFile(manifest, ARTIFACT_TYPES.EVALUATION_VERDICT, files, ["evaluation_result.json", "code_verdict.json"])
    || findManifestArtifactFile(manifest, ARTIFACT_TYPES.WORKFLOW_DECISION, files, ["next_action.json"]);
  if (!decisionFile) {
    logger.warn(`[router] collectOutbox(reviewer): no reviewer output found`);
    return { collected: false };
  }

  try {
    const raw = await readFile(join(outboxDir, decisionFile), "utf8");
    const parsed = JSON.parse(raw);
    const decision = normalizeReviewerDecision(parsed);
    const transition = buildReviewerTransition(decision.mapped, decision.reworkTarget);

    const reviewerResult = buildReviewerResult({
      source: "system_action_review_delivery",
      verdict: decision.mapped.verdict,
      score: decision.score,
      findings: decision.findings,
      failureClass: decision.mapped.verdict === "fail" ? "review_rejected" : null,
      reworkTarget: decision.reworkTarget,
      continueHint: decision.mapped.continueHint,
      contractId: activeContract?.id || null,
      ts: Date.now(),
    });

    const isReview = decisionFile === "code_verdict.json" || decisionFile === "evaluation_result.json";
    const artifactType = isReview ? ARTIFACT_TYPES.EVALUATION_VERDICT : ARTIFACT_TYPES.WORKFLOW_DECISION;
    const primaryFileName = notes[0] || decisionFile;
    const materialized = await materializeOutboxArtifacts({
      outboxDir,
      fileNames: [decisionFile, ...notes],
      logger,
      primaryFileName,
    });

    const stageRunResult = normalizeObservedStageRunResult(normalizeStageRunResult({
      ...defaults,
      status: "completed",
      summary: decision.feedback,
      feedback: decision.feedback,
      artifacts: materialized.collected.map((fileName) => ({
        type: fileName.endsWith(".md") ? ARTIFACT_TYPES.NOTES : artifactType,
        path: materialized.pathByFile.get(fileName) || join(OUTPUT_DIR, fileName),
        label: fileName,
        required: true,
        primary: fileName === primaryFileName,
      })),
      primaryArtifactPath: materialized.primaryArtifactPath,
      metadata: { outputType: artifactType },
      completion: buildCompletedStageCompletion({
        feedback: decision.feedback,
        deadEnds: decision.deadEnds,
        transition,
      }),
    }));

    return {
      collected: true,
      files: materialized.collected,
      artifactPaths: stageRunResult?.artifacts.map((artifact) => artifact.path) || [],
      primaryOutputPath: stageRunResult?.primaryArtifactPath || null,
      reviewerResult,
      reviewVerdict: parsed,
      artifactKind: isReview ? "code_review" : null,
      stageRunResult,
      stageCompletion: stageRunResult?.completion || null,
    };
  } catch (error) {
    logger.warn(`[router] collectOutbox(reviewer): parse error (${decisionFile}): ${error.message}`);
    return { collected: false, error: error.message };
  }
}
