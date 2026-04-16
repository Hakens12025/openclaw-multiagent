import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";

test("production runtime no longer imports stage-context sidechannel", async () => {
  const runtimeHandlerSource = await readFile(
    new URL("../lib/system-action/system-action-runtime.js", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(runtimeHandlerSource, /stage-context\.js/);
  assert.doesNotMatch(runtimeHandlerSource, /writeAgentInboxContext/);
});

test("production runtime has no active imports of retired context or legacy dispatch-runtime modules", async () => {
  const files = [
    new URL("../lib/system-action/system-action-runtime.js", import.meta.url),
    new URL("../lib/routing/dispatch-graph-policy.js", import.meta.url),
    new URL("../lib/session-bootstrap.js", import.meta.url),
    new URL("../lib/lifecycle/runtime-lifecycle.js", import.meta.url),
    new URL("../lib/operator/operator-snapshot-runtime.js", import.meta.url),
    new URL("../lib/admin/runtime-admin.js", import.meta.url),
    new URL("../index.js", import.meta.url),
    new URL("../routes/api.js", import.meta.url),
  ];

  for (const filePath of files) {
    const source = await readFile(filePath, "utf8");
    assert.doesNotMatch(source, /stage-context\.js/);
    assert.doesNotMatch(source, /worker-runtime-state\.js/);
  }
});

test("retired context sidechannel implementation is removed instead of being archived under lib/legacy", async () => {
  await assert.rejects(
    access(new URL("../lib/legacy/context-sidechannel/stage-context.js", import.meta.url)),
  );
});
