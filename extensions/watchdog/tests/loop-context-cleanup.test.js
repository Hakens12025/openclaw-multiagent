import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("loop cleanup leaves no active runtime references to context sidechannel", async () => {
  const handlerSource = await readFile(
    new URL("../lib/system-action/system-action-runtime.js", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(handlerSource, /context\.json/);
  assert.doesNotMatch(handlerSource, /writeAgentInboxContext/);
});
