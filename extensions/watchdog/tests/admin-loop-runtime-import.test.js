import test from "node:test";
import assert from "node:assert/strict";

test("runtime loop admin surface imports the canonical loop round starter", async () => {
  const mod = await import("../lib/admin/admin-surface-loop-operations.js");

  assert.equal(typeof mod.startRuntimeLoop, "function");
});
