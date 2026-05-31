import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";

test("admin surface operations no longer reference legacy workspace migration runtime handlers", async () => {
  const source = await readFile(new URL("../lib/admin/admin-surface-operations.js", import.meta.url), "utf8");

  assert.doesNotMatch(source, /applyRuntimeLegacyWorkspaceMigration/u);
  assert.doesNotMatch(source, /runtime\.workspace_migration/u);
  const mod = await import("../lib/admin/admin-surface-operations.js");
  assert.equal(typeof mod.executeAdminSurfaceOperation, "function");
});

test("agents dashboard no longer carries legacy workspace migration UI hooks", async () => {
  const source = await readFile(new URL("../dashboard-agents.js", import.meta.url), "utf8");

  assert.doesNotMatch(source, /dashboard-workspace-migration-actions/u);
  assert.doesNotMatch(source, /runtime\/workspace-migration/u);
  assert.doesNotMatch(source, /data-workspace-migration-apply/u);
  await assert.rejects(() => access(new URL("../dashboard-workspace-migration-actions.js", import.meta.url)));
});
