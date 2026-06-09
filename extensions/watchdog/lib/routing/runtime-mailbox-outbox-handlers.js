// lib/runtime-mailbox-outbox-handlers.js — role-specific outbox protocol handlers

import {
  readActiveInboxContract,
  collectRuntimeResult,
} from "./runtime-mailbox-outbox-helpers.js";
import { readContractSnapshotById } from "../contracts.js";

export async function collectWorkerOutbox({ agentId, outboxDir, files, logger }) {
  const inboxContract = await readActiveInboxContract(agentId);
  // `output` (the canonical deliverable path control-plane/output/<id>.md) is ROUTING metadata that the
  // task-facing inbox copy STRIPS (it is not in TASK_FACING_INBOX_ALLOW_KEYS). collectRuntimeResult needs
  // it as the mirror target — without it the worker's primary artifact is only collected under its own
  // free-chosen name (output/artifact.md) and never lands at contract.output, so evaluateContractOutcome
  // fails the contract with "contract.output missing_file" despite a valid delivery. Resolve `output` from
  // the SHARED contract (the single routing truth) so the mirror fires; we do not expose the path into the
  // agent's inbox (agents keep using relative outbox/ paths).
  let activeContract = inboxContract;
  if (inboxContract?.id && !inboxContract.output) {
    const shared = await readContractSnapshotById(inboxContract.id);
    if (shared?.output) activeContract = { ...inboxContract, output: shared.output };
  }
  return collectRuntimeResult({
    agentId,
    outboxDir,
    files,
    logger,
    activeContract,
  });
}
