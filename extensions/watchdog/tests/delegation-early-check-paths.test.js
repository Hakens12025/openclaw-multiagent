import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { agentWorkspace } from "../lib/state.js";
import {
  resolveToolWriteTargetPath,
} from "../hooks/after-tool-call.js";

test("relative write path resolves against the acting agent workspace", () => {
  const resolved = resolveToolWriteTargetPath({
    agentId: "contractor",
    rawPath: "output/result.md",
  });

  assert.equal(
    resolved,
    join(agentWorkspace("contractor"), "output", "result.md"),
  );
});

test("absolute write paths remain unchanged", () => {
  const absolute = join(agentWorkspace("contractor"), "output", "result.md");
  const resolved = resolveToolWriteTargetPath({
    agentId: "contractor",
    rawPath: absolute,
  });

  assert.equal(resolved, absolute);
});
