import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";

test("production code no longer imports retired agent-bootstrap compatibility shell", async () => {
  const files = [
    new URL("../routes/api.js", import.meta.url),
    new URL("../lib/agent/agent-enrollment.js", import.meta.url),
    new URL("../lib/agent/agent-admin-agent-operations.js", import.meta.url),
    new URL("../lib/agent/agent-admin-profile.js", import.meta.url),
    new URL("../lib/agent/agent-enrollment-guidance.js", import.meta.url),
    new URL("../lib/agent/agent-enrollment-discovery.js", import.meta.url),
    new URL("../lib/admin/admin-surface-graph-operations.js", import.meta.url),
    new URL("../lib/effective-profile-composer.js", import.meta.url),
  ];

  for (const filePath of files) {
    const source = await readFile(filePath, "utf8");
    assert.doesNotMatch(source, /agent-bootstrap\.js/);
  }
});

test("agent-bootstrap compatibility shell has been retired from the codebase", async () => {
  const fileUrl = new URL("../lib/agent/agent-bootstrap.js", import.meta.url);
  await assert.rejects(
    access(fileUrl, fsConstants.F_OK),
    /ENOENT/,
  );
});
