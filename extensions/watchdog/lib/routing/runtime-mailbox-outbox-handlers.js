// lib/runtime-mailbox-outbox-handlers.js — role-specific outbox protocol handlers

import {
  readActiveInboxContract,
  collectRuntimeResult,
} from "./runtime-mailbox-outbox-helpers.js";

export async function collectWorkerOutbox({ agentId, outboxDir, files, logger }) {
  return collectRuntimeResult({
    agentId,
    outboxDir,
    files,
    logger,
    activeContract: await readActiveInboxContract(agentId),
  });
}
