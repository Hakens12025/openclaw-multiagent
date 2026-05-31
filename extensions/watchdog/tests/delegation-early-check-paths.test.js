import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { agentWorkspace } from "../lib/state.js";
import { CONTROL_PLANE_PATHS } from "../lib/control-plane/control-plane-paths.js";
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

test("contract-bound output alias resolves to contract.output instead of local workspace output", () => {
  const contractOutput = join(CONTROL_PLANE_PATHS.outputDir, "TC-early-check.md");
  const resolved = resolveToolWriteTargetPath({
    agentId: "contractor",
    rawPath: "output/TC-early-check.md",
    trackingState: {
      contract: {
        output: contractOutput,
      },
    },
  });

  assert.equal(resolved, contractOutput);
});
