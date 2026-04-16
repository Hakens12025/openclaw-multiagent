import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { clearContractStore } from "../lib/store/contract-store.js";

const logger = {
  info() {},
  warn() {},
  error() {},
};

async function clearDraftContractResidue() {
  const stateModule = await import("../lib/state.js");
  stateModule.draftContracts?.clear?.();
}

test.afterEach(async () => {
  clearContractStore();
  await clearDraftContractResidue();
});

test("contract-flow-store no longer exposes draft contract side-store APIs", async () => {
  const store = await import("../lib/store/contract-flow-store.js");

  assert.equal("hasDraftContract" in store, false);
  assert.equal("getDraftContractCount" in store, false);
  assert.equal("rememberDraftContract" in store, false);
  assert.equal("forgetDraftContract" in store, false);
  assert.equal("clearDraftContractStore" in store, false);
});

test("execution routing no longer exports planner draft inbox helpers", async () => {
  const handlers = await import("../lib/routing/runtime-mailbox-inbox-handlers.js");
  const contracts = await import("../lib/contracts.js");

  assert.equal("routePlannerInbox" in handlers, false);
  assert.equal("promoteContract" in contracts, false);
});

test("control-plane source files no longer mention draftContracts residue", async () => {
  const fileChecks = [
    ["state-collections", "/Users/hakens/.openclaw/extensions/watchdog/lib/state-collections.js"],
    ["contract-flow-store", "/Users/hakens/.openclaw/extensions/watchdog/lib/store/contract-flow-store.js"],
    ["state-persistence", "/Users/hakens/.openclaw/extensions/watchdog/lib/state-persistence.js"],
    ["runtime-admin", "/Users/hakens/.openclaw/extensions/watchdog/lib/admin/runtime-admin.js"],
    ["crash-recovery", "/Users/hakens/.openclaw/extensions/watchdog/lib/lifecycle/crash-recovery.js"],
    ["runtime-mailbox-inbox-handlers", "/Users/hakens/.openclaw/extensions/watchdog/lib/routing/runtime-mailbox-inbox-handlers.js"],
  ];

  for (const [label, filePath] of fileChecks) {
    const source = await readFile(filePath, "utf8");
    assert.doesNotMatch(source, /\bdraftContracts\b/, `${label} still mentions draftContracts`);
    assert.doesNotMatch(source, /\bhasDraftContract\b/, `${label} still mentions hasDraftContract`);
    assert.doesNotMatch(source, /\bgetDraftContractCount\b/, `${label} still mentions getDraftContractCount`);
    assert.doesNotMatch(source, /\bclearDraftContractStore\b/, `${label} still mentions clearDraftContractStore`);
    assert.doesNotMatch(source, /\brememberDraftContract\b/, `${label} still mentions rememberDraftContract`);
    assert.doesNotMatch(source, /\bforgetDraftContract\b/, `${label} still mentions forgetDraftContract`);
  }
});

test("execution routing source files no longer mention planner draft promotion flow", async () => {
  const fileChecks = [
    ["contracts", "/Users/hakens/.openclaw/extensions/watchdog/lib/contracts.js"],
    ["crash-recovery", "/Users/hakens/.openclaw/extensions/watchdog/lib/lifecycle/crash-recovery.js"],
    ["runtime-mailbox-inbox-handlers", "/Users/hakens/.openclaw/extensions/watchdog/lib/routing/runtime-mailbox-inbox-handlers.js"],
    ["before-start-ingress", "/Users/hakens/.openclaw/extensions/watchdog/lib/ingress/before-start-ingress.js"],
  ];

  for (const [label, filePath] of fileChecks) {
    const source = await readFile(filePath, "utf8");
    assert.doesNotMatch(source, /\broutePlannerInbox\b/, `${label} still mentions routePlannerInbox`);
    assert.doesNotMatch(source, /\bpromoteContract\b/, `${label} still mentions promoteContract`);
    assert.doesNotMatch(source, /\bdraft → pending\b/, `${label} still mentions draft promotion`);
    assert.doesNotMatch(source, /\borphan draft\b/i, `${label} still mentions orphan draft recovery`);
    assert.doesNotMatch(source, /\bdraft contract\b/i, `${label} still mentions draft contract wake text`);
    assert.doesNotMatch(source, /\bplanner retry\b/i, `${label} still mentions planner retry wake text`);
  }
});
