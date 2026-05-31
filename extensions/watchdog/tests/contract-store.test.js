import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import {
  cacheContractSnapshot,
  clearContractStore,
  readCachedContractSnapshotById,
} from "../lib/store/contract-store.js";

test("contract store indexes cached snapshots by canonical contract id", async () => {
  clearContractStore();
  try {
    cacheContractSnapshot("/tmp/openclaw-contract-store/TC-CANONICAL.json", {
      id: "TC-CANONICAL",
      task: "canonical lookup",
    });

    const snapshot = await readCachedContractSnapshotById("tc-canonical", {
      contractPathHint: join("/tmp", "openclaw-contract-store", "missing.json"),
    });

    assert.equal(snapshot?.id, "TC-CANONICAL");
  } finally {
    clearContractStore();
  }
});
