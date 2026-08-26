import test from "node:test";
import assert from "node:assert/strict";

import {
  evaluateGroupSpecRedlines,
  evaluateGroupExpansion,
  extractGroupSessions,
  PROBE_GROUP_ID,
} from "../lib/formal-runtime/suite-group.js";

test("evaluateGroupSpecRedlines passes against the real normalizeGroupSpec (rejects invalid, drops non-member edges)", () => {
  const r = evaluateGroupSpecRedlines();
  assert.equal(r.ok, true, r.problems.join("; "));
});

test("evaluateGroupExpansion passes against the real expandAgentGroup (edges tagged with groupId + groupSession)", () => {
  const r = evaluateGroupExpansion();
  assert.equal(r.ok, true, r.problems.join("; "));
  assert.ok(r.edgeCount >= 1);
});

test("extractGroupSessions tolerates array / {active,recent} / {groupSessions} shapes", () => {
  assert.deepEqual(extractGroupSessions([{ groupId: "a" }]).map((g) => g.groupId), ["a"]);
  assert.deepEqual(
    extractGroupSessions({ active: { groupId: "x" }, recent: [{ groupId: "y" }] }).map((g) => g.groupId),
    ["x", "y"],
  );
  assert.deepEqual(extractGroupSessions({ groupSessions: [{ groupId: "z" }] }).map((g) => g.groupId), ["z"]);
  assert.deepEqual(extractGroupSessions(null), []);
  assert.deepEqual(extractGroupSessions("nope"), []);
});

test("probe group id is a stable, distinctive constant", () => {
  assert.equal(PROBE_GROUP_ID, "formal-group-probe");
});
