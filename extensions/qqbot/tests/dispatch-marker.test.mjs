import test from "node:test";
import assert from "node:assert/strict";

import { parseDispatchMarker } from "../dist/src/dispatch-marker.js";

test("parseDispatchMarker accepts [ACTION] delegate with em-dash", () => {
  assert.deepEqual(
    parseDispatchMarker("[ACTION] delegate worker — 研究 React 是什么"),
    {
      message: "研究 React 是什么",
      targetAgent: "worker",
      format: "action_delegate",
    },
  );
});

test("parseDispatchMarker accepts [ACTION] delegate with ASCII dash", () => {
  assert.deepEqual(
    parseDispatchMarker("[ACTION] delegate worker - 做一个报告"),
    {
      message: "做一个报告",
      targetAgent: "worker",
      format: "action_delegate",
    },
  );
});

test("parseDispatchMarker accepts [ACTION] delegate JSON form", () => {
  assert.deepEqual(
    parseDispatchMarker('[ACTION] delegate {"targetAgent":"worker","message":"hi"}'),
    {
      message: "hi",
      targetAgent: "worker",
      format: "action_delegate",
    },
  );
});

test("parseDispatchMarker returns null for bodyless [ACTION] delegate", () => {
  assert.equal(parseDispatchMarker("[ACTION] delegate"), null);
  assert.equal(parseDispatchMarker("[ACTION] delegate "), null);
});

test("legacy [DISPATCH]...[/DISPATCH] is no longer parsed", () => {
  assert.equal(
    parseDispatchMarker("[DISPATCH]研究 React 是什么[/DISPATCH]"),
    null,
  );
  assert.equal(
    parseDispatchMarker('[DISPATCH]{"message":"hi","targetAgent":"worker"}[/DISPATCH]'),
    null,
  );
});

test("[ACTION] delegate wins when a message contains both forms", () => {
  const result = parseDispatchMarker("[DISPATCH]old[/DISPATCH]\n[ACTION] delegate worker — new");
  assert.equal(result?.format, "action_delegate");
  assert.equal(result?.targetAgent, "worker");
  assert.equal(result?.message, "new");
});
