import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  getArtifactLaneDefinition,
  listArtifactLaneBindingsForRole,
  resolveArtifactStageDefinition,
} from "../lib/artifact-lane-registry.js";

test("artifact lane registry resolves canonical code_review lane semantics", () => {
  const lane = getArtifactLaneDefinition("code_review");

  assert.equal(lane?.kind, "code_review");
  assert.equal(lane?.fileName, "code_review.json");
  assert.deepEqual(lane?.roles, ["reviewer"]);
  assert.deepEqual(
    resolveArtifactStageDefinition({ kind: "code_review" }),
    {
      stageId: "code_review",
      stageLabel: "代码审查",
    },
  );
});

test("artifact lane registry exposes reviewer bindings without consumer-local file maps", () => {
  const reviewerBindings = listArtifactLaneBindingsForRole("reviewer");

  assert.equal(Array.isArray(reviewerBindings), true);
  assert.equal(reviewerBindings.some((binding) => binding.kind === "code_review"), true);
  assert.equal(reviewerBindings.some((binding) => binding.fileName === "code_review.json"), true);
});

test("artifact-backed consumers no longer hardcode code_review inbox filenames", async () => {
  const files = [
    join(process.cwd(), "lib", "session-bootstrap.js"),
    join(process.cwd(), "lib", "heartbeat-gate.js"),
    join(process.cwd(), "lib", "tracking-work-item.js"),
  ];

  for (const filePath of files) {
    const content = await readFile(filePath, "utf8");
    assert.doesNotMatch(content, /\bcode_review\.json\b/, `${filePath} still hardcodes code_review.json`);
  }
});

