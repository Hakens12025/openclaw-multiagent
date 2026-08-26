import test from "node:test";
import assert from "node:assert/strict";

import { normalizeVerificationStatus } from "../lib/admin/change-sets/admin-change-set-history.js";
import { buildAdminChangeSetPreview } from "../lib/admin/change-sets/admin-change-set-preview.js";

test("normalizeVerificationStatus treats finalizing test runs as running", () => {
  assert.equal(
    normalizeVerificationStatus({
      status: "finalizing",
      totalCases: 3,
      completedCases: 3,
    }),
    "running",
  );
});

test("buildAdminChangeSetPreview does not fall back to stale draft surface metadata", () => {
  const preview = buildAdminChangeSetPreview({
    id: "ACS-stale-surface",
    surfaceId: "surface.removed.from.registry",
    confirmation: "explicit",
    surfaceStatus: "active",
    surfaceMethod: "DELETE",
    surfacePath: "/watchdog/legacy/path",
    managementContext: {
      surfaceId: "surface.removed.from.registry",
      subjectKind: "agent",
      selectorKey: "agentId",
      selectorValue: "legacy-agent",
    },
    changeSet: {
      payload: {
        agentId: "legacy-agent",
      },
    },
  });

  assert.equal(preview.supported, false);
  assert.equal(preview.executable, false);
  assert.equal(preview.status, null);
  assert.equal(preview.confirmation, null);
  assert.equal(preview.request.method, null);
  assert.equal(preview.request.path, null);
  assert.deepEqual(preview.payload, {
    agentId: "legacy-agent",
  });
});
