import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

function fileUrl(relativePath) {
  return new URL(relativePath, import.meta.url);
}

test("active consumers import agent discovery and guidance from split modules instead of enrollment compatibility shell", async () => {
  const enrollmentSource = await readFile(
    fileUrl("../lib/agent/agent-enrollment.js"),
    "utf8",
  );
  const operatorCatalogSource = await readFile(
    fileUrl("../routes/operator-catalog.js"),
    "utf8",
  );
  const apiRouteSource = await readFile(
    fileUrl("../routes/api.js"),
    "utf8",
  );
  const adminSurfaceOperationsSource = await readFile(
    fileUrl("../lib/admin/admin-surface-operations.js"),
    "utf8",
  );

  assert.doesNotMatch(
    enrollmentSource,
    /export\s*\{[\s\S]*summarizeLocalAgentDiscovery[\s\S]*\}\s*from "\.\/agent-enrollment-discovery\.js"/,
    "agent-enrollment should not re-export discovery helpers as an active compatibility shell",
  );
  assert.doesNotMatch(
    enrollmentSource,
    /export\s*\{[\s\S]*(readLocalAgentGuidancePreview|writeLocalAgentGuidanceContent|takeOverLocalAgentGuidance)[\s\S]*\}\s*from "\.\/agent-enrollment-guidance\.js"/,
    "agent-enrollment should not re-export guidance helpers as an active compatibility shell",
  );

  assert.match(
    operatorCatalogSource,
    /from "\.\.\/lib\/agent\/agent-enrollment-discovery\.js"/,
    "operator catalog should import discovery helpers from the split discovery module",
  );
  assert.match(
    operatorCatalogSource,
    /from "\.\.\/lib\/agent\/agent-enrollment-guidance\.js"/,
    "operator catalog should import guidance preview from the split guidance module",
  );
  assert.doesNotMatch(
    operatorCatalogSource,
    /from "\.\.\/lib\/agent\/agent-enrollment\.js"/,
    "operator catalog should not depend on the enrollment compatibility shell for discovery or guidance",
  );

  assert.match(
    apiRouteSource,
    /from "\.\.\/lib\/agent\/agent-enrollment-guidance\.js"/,
    "api route should import guidance write from the split guidance module",
  );
  assert.doesNotMatch(
    apiRouteSource,
    /writeLocalAgentGuidanceContent[\s\S]*from "\.\.\/lib\/agent\/agent-enrollment\.js"/,
    "api route should not import guidance write through the enrollment compatibility shell",
  );

  assert.match(
    adminSurfaceOperationsSource,
    /from "\.\.\/agent\/agent-enrollment-guidance\.js"/,
    "admin surface operations should import guidance takeover from the split guidance module",
  );
  assert.doesNotMatch(
    adminSurfaceOperationsSource,
    /takeOverLocalAgentGuidance[\s\S]*from "\.\.\/agent\/agent-enrollment\.js"/,
    "admin surface operations should not import guidance takeover through the enrollment compatibility shell",
  );
});
