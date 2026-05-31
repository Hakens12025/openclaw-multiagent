import test from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

import { executeAdminSurfaceOperation } from "../lib/admin/admin-surface-operations.js";
import { CONTROL_PLANE_PATHS } from "../lib/control-plane/control-plane-paths.js";

const logger = { info() {}, warn() {} };
const SNAP_FILE = CONTROL_PLANE_PATHS.structureSnapshotsFile;

test("B3: destructive/structural apply captures a pre-apply structure snapshot (rollback net)", async () => {
  try {
    // graph.loop.delete is risk:structural — the net fires even when the op is a no-op
    // (nonexistent loop), proving the snapshot precedes the handler. No graph mutation.
    const res = await executeAdminSurfaceOperation({
      surfaceId: "graph.loop.delete",
      payload: { loopId: "b3-net-probe-nonexistent" },
      logger,
    });
    assert.equal(res.ok, false, "deleting a nonexistent loop is a no-op");
    assert.match(res.preApplySnapshot || "", /^SNAP-\d+-[0-9a-f]{8}$/, "structural apply must carry a pre-apply snapshot id");
  } finally {
    await rm(SNAP_FILE, { force: true });
  }
});

test("B3: safe-risk apply does NOT capture a snapshot (net is scoped to destructive/structural)", async () => {
  const id = `b3-safe-probe-${process.pid}`;
  try {
    // skills.create is risk:safe → no pre-apply snapshot
    const res = await executeAdminSurfaceOperation({
      surfaceId: "skills.create",
      payload: { skillId: id, description: "b3 safe probe", body: "x" },
      logger,
    });
    assert.equal(res.ok, true);
    assert.equal(res.preApplySnapshot, undefined, "safe surface must not trigger the pre-apply snapshot net");
  } finally {
    await rm(join(homedir(), ".openclaw", "skills", id), { recursive: true, force: true });
    await rm(SNAP_FILE, { force: true });
  }
});
