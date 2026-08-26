import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";

test("admin surface operations no longer reference legacy workspace migration runtime handlers", async () => {
  const source = await readFile(new URL("../lib/admin/operations/admin-surface-operations.js", import.meta.url), "utf8");

  assert.doesNotMatch(source, /applyRuntimeLegacyWorkspaceMigration/u);
  assert.doesNotMatch(source, /runtime\.workspace_migration/u);
  const mod = await import("../lib/admin/operations/admin-surface-operations.js");
  assert.equal(typeof mod.executeAdminSurfaceOperation, "function");
});

