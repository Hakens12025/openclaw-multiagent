import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { isPathInsideRoot } from "../lib/harness/harness-module-evidence.js";

// The single canonical path-containment check consumed by both the harness scope
// evaluator and the before_tool_call sandbox guard (A1-path-unify).
test("isPathInsideRoot: core containment semantics", () => {
  const root = join("/srv", "agent", "sandbox");
  assert.equal(isPathInsideRoot(join(root, "sub", "f.txt"), root), true, "inside");
  assert.equal(isPathInsideRoot(root, root), true, "target === root");
  assert.equal(isPathInsideRoot(`${root}-evil/secret.txt`, root), false, "sibling prefix must NOT pass");
  assert.equal(isPathInsideRoot(join("/srv", "other", "x"), root), false, "outside");
  assert.equal(isPathInsideRoot("", root), false, "empty target");
  assert.equal(isPathInsideRoot(root, ""), false, "empty root");
});

// FIX(A1-path-unify/review): on win32 a cross-drive relative() is absolute and must be rejected.
// On POSIX cross-drive paths don't exist, so this asserts only where it's reachable.
test("isPathInsideRoot: cross-drive paths are rejected on win32", { skip: process.platform !== "win32" }, () => {
  assert.equal(isPathInsideRoot("D:\\data\\x.txt", "C:\\srv\\sandbox"), false, "cross-drive must NOT pass");
  assert.equal(isPathInsideRoot("C:\\srv\\sandbox\\sub\\f", "C:\\srv\\sandbox"), true, "same-drive inside still passes");
});
