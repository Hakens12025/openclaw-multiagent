import test from "node:test";
import assert from "node:assert/strict";

import { repairTruncatedJsonText, parsePlannerJson } from "../lib/llm-planner.js";

// Defensive JSON handling for glm-style truncated planner output (CLAUDE.md defensive_json_handling).
// parsePlannerJson must salvage the common "cut off at the end" case and, when unsalvageable,
// throw a CODED error so operator-runtime routes it to invalid-plan (not brain-unavailable).

test("parsePlannerJson passes through valid JSON unchanged", () => {
  const obj = { summary: "x", steps: [{ surfaceId: "agents.create", payload: { id: "w" } }] };
  assert.deepEqual(parsePlannerJson(JSON.stringify(obj)), obj);
});

test("repairTruncatedJsonText closes a string + objects + array cut off at the end", () => {
  const truncated = '{"summary":"build","steps":[{"surfaceId":"agents.create","payload":{"id":"work';
  const repaired = repairTruncatedJsonText(truncated);
  const parsed = JSON.parse(repaired); // must be structurally valid after repair
  assert.equal(parsed.summary, "build");
  assert.equal(parsed.steps[0].surfaceId, "agents.create");
  assert.equal(parsed.steps[0].payload.id, "work");
});

test("repairTruncatedJsonText drops trailing commas before closers (string-aware)", () => {
  assert.deepEqual(JSON.parse(repairTruncatedJsonText('{"a":1,"b":[1,2,],}')), { a: 1, b: [1, 2] });
  // a comma INSIDE a string must be preserved
  assert.deepEqual(JSON.parse(repairTruncatedJsonText('{"a":"x,}"}')), { a: "x,}" });
});

test("parsePlannerJson repairs trailing comma + truncation transparently", () => {
  const parsed = parsePlannerJson('{"intent":"build","steps":[{"surfaceId":"graph.loop.compose"},]');
  assert.equal(parsed.intent, "build");
  assert.equal(parsed.steps[0].surfaceId, "graph.loop.compose");
});

test("parsePlannerJson throws PLANNER_JSON_PARSE_FAILED on unsalvageable input", () => {
  try {
    parsePlannerJson("this is not json at all <<<");
    assert.fail("should have thrown");
  } catch (err) {
    assert.equal(err.code, "PLANNER_JSON_PARSE_FAILED");
  }
});
