import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// 仓内定位:以本文件为锚(tests/ → watchdog 根),不写死机器路径——CI/别机同样可解析。
const wd = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url));

import { buildRuntimeSummary } from "../lib/operator/operator-snapshot-runtime.js";

test("contract-flow-store no longer exposes pending dispatch side-store APIs", async () => {
  const store = await import("../lib/store/contract-flow-store.js");

  assert.equal("rememberPendingDispatch" in store, false);
  assert.equal("forgetPendingDispatch" in store, false);
  assert.equal("snapshotPendingDispatches" in store, false);
  assert.equal("clearPendingDispatchStore" in store, false);
});

test("buildRuntimeSummary no longer exposes pendingDispatches residue", () => {
  const summary = buildRuntimeSummary(10);

  assert.equal("pendingDispatches" in summary, false);
});

test("control-plane sources no longer mention pending dispatch residue", async () => {
  const fileChecks = [
    ["state-collections", wd("lib/state/state-collections.js")],
    ["contract-flow-store", wd("lib/store/contract-flow-store.js")],
    ["runtime-admin", wd("lib/admin/runtime-admin.js")],
    ["operator-snapshot-runtime", wd("lib/operator/operator-snapshot-runtime.js")],
    ["operator-snapshot", wd("lib/operator/operator-snapshot.js")],
    ["routes-api", wd("routes/api.js")],
  ];

  for (const [label, filePath] of fileChecks) {
    const source = await readFile(filePath, "utf8");
    assert.doesNotMatch(source, /\bpendingDispatches\b/, `${label} still mentions pendingDispatches`);
    assert.doesNotMatch(source, /\bsnapshotPendingDispatches\b/, `${label} still mentions snapshotPendingDispatches`);
    assert.doesNotMatch(source, /\brememberPendingDispatch\b/, `${label} still mentions rememberPendingDispatch`);
    assert.doesNotMatch(source, /\bforgetPendingDispatch\b/, `${label} still mentions forgetPendingDispatch`);
    assert.doesNotMatch(source, /\bclearPendingDispatchStore\b/, `${label} still mentions clearPendingDispatchStore`);
    assert.doesNotMatch(source, /\bsnapshotPendingPlannerDispatches\b/, `${label} still mentions snapshotPendingPlannerDispatches`);
  }
});
