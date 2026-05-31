import {
  OUTBOX_COMMIT_KINDS,
} from "../protocol-primitives.js";
import {
  getRuntimeAgentConfig,
} from "../agent/agent-identity.js";
import {
  routeWorkerInbox,
} from "./runtime-mailbox-inbox-handlers.js";
import {
  collectWorkerOutbox,
} from "./runtime-mailbox-outbox-handlers.js";
import { composeRuntimeCapabilityProfile } from "../effective-profile-composer.js";
import { normalizeString } from "../core/normalize.js";
import { getAgentCard } from "../store/agent-card-store.js";

const MAILBOX_HANDLER_REGISTRY = Object.freeze([
  // All execution-layer agents use the unified executor_contract handler.
  {
    id: "executor_contract",
    kinds: [OUTBOX_COMMIT_KINDS.EXECUTION_RESULT, "worker_output", "executor_contract"],
    // P6-Phase1: 删除死字段 matchAgent（全仓从未被调用）；handler 解析实际走
    // routerHandlerId / outboxCommitKinds（capability profile），见 resolveCapabilityMailboxHandler。
    routeInbox: (params) => routeWorkerInbox(params),
    collectOutbox: ({ agentId, outboxDir, files, logger }) => collectWorkerOutbox({
      agentId,
      outboxDir,
      files,
      logger,
    }),
    preserveInbox: () => false,
  },
  // research_search_space and evaluation_result handlers removed.
  // All execution-layer agents now use executor_contract handler.
]);

function resolveMailboxHandlerByKind(kind) {
  const normalizedKind = normalizeString(kind);
  if (!normalizedKind) return null;
  return MAILBOX_HANDLER_REGISTRY.find((handler) => Array.isArray(handler.kinds) && handler.kinds.includes(normalizedKind)) || null;
}

function readAgentMailboxCapabilities(agentId) {
  const normalizedAgentId = normalizeString(agentId);
  if (!normalizedAgentId) {
    return { routerHandlerId: null, outboxCommitKinds: [] };
  }

  return composeRuntimeCapabilityProfile({
    agentId: normalizedAgentId,
    runtimeConfig: getRuntimeAgentConfig(normalizedAgentId),
    card: getAgentCard(normalizedAgentId),
  });
}

function resolveCapabilityMailboxHandler(agentId) {
  const capabilities = readAgentMailboxCapabilities(agentId);
  if (capabilities.routerHandlerId) {
    const handlerById = resolveMailboxHandlerById(capabilities.routerHandlerId);
    if (handlerById) {
      return handlerById;
    }
  }

  for (const kind of capabilities.outboxCommitKinds) {
    const handlerByKind = resolveMailboxHandlerByKind(kind);
    if (handlerByKind) {
      return handlerByKind;
    }
  }

  return null;
}

function resolveDefaultMailboxHandler() {
  return resolveMailboxHandlerById("executor_contract");
}

export function resolveMailboxHandlerForAgent(agentId) {
  const capabilityHandler = resolveCapabilityMailboxHandler(agentId);
  if (capabilityHandler) {
    return capabilityHandler;
  }

  return resolveDefaultMailboxHandler();
}

function resolveMailboxHandlerById(handlerId) {
  return MAILBOX_HANDLER_REGISTRY.find((handler) => handler.id === handlerId) || null;
}

export function resolveMailboxOutboxHandler(agentId) {
  return resolveMailboxHandlerForAgent(agentId) || resolveDefaultMailboxHandler();
}

export function shouldPreserveMailboxInbox(agentId, executionObservation) {
  const handler = resolveMailboxHandlerById(executionObservation?.routerHandlerId)
    || resolveMailboxHandlerForAgent(agentId)
    || resolveDefaultMailboxHandler();
  return handler?.preserveInbox?.(agentId, executionObservation?.collected === true) === true;
}
