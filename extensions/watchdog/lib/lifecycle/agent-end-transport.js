import { collectOutbox } from "../../runtime-mailbox.js";
import { cleanInbox } from "../routing/runtime-mailbox-transport.js";
import {
  shouldPreserveRouterInbox,
} from "../routing/runtime-mailbox-handler-registry.js";
import { materializeExecutionObservation } from "../execution-observation.js";
import { buildImplicitTextOutputStageRunResult } from "../routing/runtime-mailbox-outbox-helpers.js";
import {
  isDirectRequestEnvelope,
  resolveDirectRequestEnvelopeSessionKey,
} from "../protocol-primitives.js";
import { runtimeWakeAgentDetailed } from "../transport/runtime-wake-transport.js";

function buildSyntheticOutputCommitObservation({
  agentId,
  event,
  trackingState,
}) {
  if (event?.commitType !== "output_commit") {
    return null;
  }

  const activeContract = trackingState?.contract;
  const primaryOutputPath = typeof activeContract?.output === "string" && activeContract.output.trim()
    ? activeContract.output.trim()
    : null;
  if (!primaryOutputPath) {
    return null;
  }

  const stageRunResult = buildImplicitTextOutputStageRunResult({
    activeContract,
    agentId,
    artifactPaths: [primaryOutputPath],
    primaryOutputPath,
    summary: "1 output file(s) collected",
    feedback: "stage completed from canonical contract.output commit",
  });
  if (!stageRunResult) {
    return null;
  }

  return materializeExecutionObservation({
    collected: true,
    contractId: activeContract?.id || null,
    files: [],
    artifactPaths: [primaryOutputPath],
    primaryOutputPath,
    stageRunResult,
    stageCompletion: stageRunResult.completion || null,
  }, {
    contractId: activeContract?.id || null,
    fallbackPrimaryOutputPath: primaryOutputPath,
  });
}

export async function handleAgentEndTransport({
  agentId,
  api,
  logger,
  enqueueContract,
  event = null,
  trackingState = null,
}) {
  const collectedTransport = await collectOutbox(agentId, logger);
  const executionObservation = collectedTransport?.collected
    ? materializeExecutionObservation(collectedTransport)
    : (
        buildSyntheticOutputCommitObservation({
          agentId,
          event,
          trackingState,
        }) || materializeExecutionObservation(collectedTransport)
      );
  if (executionObservation.collected) {
    logger.info(`[watchdog] collectOutbox(${agentId}): success`);

    // DRAFT lifecycle eliminated — dispatch-graph-policy handles all forwarding.
  }

  return {
    executionObservation,
    preserveInbox: shouldPreserveRouterInbox(agentId, executionObservation),
  };
}

export async function cleanupAgentEndTransport({
  agentId,
  api = null,
  logger,
  preserveInbox = false,
}) {
  if (preserveInbox) {
    return {
      cleaned: false,
      preserved: true,
      promotedDirectEnvelope: null,
      wake: null,
    };
  }

  const cleanupResult = await cleanInbox(agentId, logger);
  const promotedDirectEnvelope = cleanupResult?.promotedDirectEnvelope || null;
  let wake = null;

  if (
    api
    && promotedDirectEnvelope
    && isDirectRequestEnvelope(promotedDirectEnvelope)
  ) {
    const targetSessionKey = resolveDirectRequestEnvelopeSessionKey(promotedDirectEnvelope);
    wake = await runtimeWakeAgentDetailed(
      agentId,
      `resume queued direct request ${promotedDirectEnvelope.id}`,
      api,
      logger,
      targetSessionKey ? { sessionKey: targetSessionKey } : {},
    );
  }

  return {
    cleaned: cleanupResult?.cleaned === true,
    preserved: false,
    promotedDirectEnvelope,
    wake,
  };
}
