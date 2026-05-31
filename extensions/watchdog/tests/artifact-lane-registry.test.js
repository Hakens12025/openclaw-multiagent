import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  getArtifactLaneDefinition,
  listArtifactLaneBindingsForRole,
  listArtifactLaneBindingsForSkill,
  resolveArtifactStageDefinition,
} from "../lib/artifact-lane-registry.js";

const WATCHDOG_ROOT = fileURLToPath(new URL("..", import.meta.url));

test("artifact lane registry resolves canonical code_review lane semantics", () => {
  const lane = getArtifactLaneDefinition("code_review");

  assert.equal(lane?.kind, "code_review");
  assert.equal(lane?.fileName, "code_review.json");
  // Lanes are now bound by skill, not role name.
  assert.deepEqual(lane?.skills, ["review-findings"]);
  assert.deepEqual(
    resolveArtifactStageDefinition({ kind: "code_review" }),
    {
      stageId: "code_review",
      stageLabel: "代码审查",
    },
  );
});

test("artifact lane registry exposes reviewer bindings via role (resolved through capability preset skills)", () => {
  const reviewerBindings = listArtifactLaneBindingsForRole("reviewer");

  assert.equal(Array.isArray(reviewerBindings), true);
  assert.equal(reviewerBindings.some((binding) => binding.kind === "code_review"), true);
  assert.equal(reviewerBindings.some((binding) => binding.fileName === "code_review.json"), true);
});

test("artifact lane registry exposes code_review lane via review-findings skill", () => {
  const skillBindings = listArtifactLaneBindingsForSkill("review-findings");

  assert.equal(Array.isArray(skillBindings), true);
  assert.equal(skillBindings.some((binding) => binding.kind === "code_review"), true);
  assert.equal(skillBindings.some((binding) => binding.fileName === "code_review.json"), true);
});

test("artifact lane registry returns empty for roles without review-findings skill", () => {
  const executorBindings = listArtifactLaneBindingsForRole("executor");
  assert.equal(Array.isArray(executorBindings), true);
  assert.equal(executorBindings.length, 0);
});

test("artifact-backed consumers no longer hardcode code_review inbox filenames", async () => {
  const files = [
    join(WATCHDOG_ROOT, "lib", "session-bootstrap.js"),
    join(WATCHDOG_ROOT, "lib", "heartbeat-gate.js"),
    join(WATCHDOG_ROOT, "lib", "tracking-work-item.js"),
  ];

  for (const filePath of files) {
    const content = await readFile(filePath, "utf8");
    assert.doesNotMatch(content, /\bcode_review\.json\b/, `${filePath} still hardcodes code_review.json`);
  }
});
