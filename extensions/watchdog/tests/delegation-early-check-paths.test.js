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

test("local workspace output paths stay themselves — no alias remap to contract.output (seam H4e)", () => {
  // The old alias remap returned contract.output here, awarding commit credit
  // for bytes that never reached the truth file (the symlink was never
  // provisioned in production). Paths now resolve honestly.
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

  assert.notEqual(resolved, contractOutput);
  assert.match(resolved, /output\/TC-early-check\.md$/u);
});
