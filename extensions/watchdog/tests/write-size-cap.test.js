import test from "node:test";
import assert from "node:assert/strict";

import { checkWriteSize, collectWriteContent } from "../lib/security/security.js";
import {
  DEFAULT_MAX_WRITE_BYTES,
  resolveMaxWriteBytesFromPolicy,
} from "../lib/security/execution-policy-defaults.js";

test("checkWriteSize blocks a write whose content exceeds the cap", () => {
  const result = checkWriteSize("write", { content: "x".repeat(101) }, 100);
  assert.equal(result?.block, true);
  assert.match(result.blockReason, /101 字节/u);
  assert.match(result.blockReason, /上限 100 字节/u);
});

test("checkWriteSize allows content at or under the cap", () => {
  assert.equal(checkWriteSize("write", { content: "x".repeat(100) }, 100), null);
  assert.equal(checkWriteSize("Write", { content: "ok" }, 100), null);
});

test("checkWriteSize measures UTF-8 bytes, not character count", () => {
  // "中" = 3 UTF-8 bytes: 2 chars => length 2, byteLength 6.
  const content = "中".repeat(2);
  assert.equal(checkWriteSize("write", { content }, 5)?.block, true, "6 bytes > 5 cap");
  assert.equal(checkWriteSize("write", { content }, 6), null, "6 bytes == 6 cap passes");
});

test("checkWriteSize covers edit tools via new_string / newText fields", () => {
  const big = "y".repeat(200);
  assert.equal(checkWriteSize("edit", { new_string: big }, 100)?.block, true);
  assert.equal(checkWriteSize("Edit", { newText: big }, 100)?.block, true);
});

test("checkWriteSize sums all content fields before comparing", () => {
  // content(60) + "\n" + new_string(60) = 121 bytes > 100.
  const result = checkWriteSize(
    "write",
    { content: "a".repeat(60), new_string: "b".repeat(60) },
    100,
  );
  assert.equal(result?.block, true);
  assert.match(result.blockReason, /121 字节/u);
});

test("checkWriteSize ignores non-write tools and empty content", () => {
  assert.equal(checkWriteSize("read", { content: "x".repeat(10_000) }, 100), null);
  assert.equal(checkWriteSize("web_fetch", { url: "https://example.com" }, 100), null);
  assert.equal(checkWriteSize("write", {}, 100), null);
  assert.equal(checkWriteSize("write", { content: "" }, 100), null);
});

test("checkWriteSize treats a non-positive cap as a no-op", () => {
  assert.equal(checkWriteSize("write", { content: "x".repeat(1000) }, 0), null);
  assert.equal(checkWriteSize("write", { content: "x".repeat(1000) }, Number.NaN), null);
});

test("collectWriteContent joins the canonical write/edit content fields", () => {
  assert.equal(collectWriteContent({ content: "a", new_string: "b" }), "a\nb");
  assert.equal(collectWriteContent({}), "");
});

// FIX(A3-write-size-cap/review): apply_patch (patch/input envelope) and multi_edit
// (edits[] array) are matched by WRITE_TOOL_PATTERN but carry content outside the flat
// fields — the size cap must still see their payload.
test("checkWriteSize covers apply_patch via patch / input envelope fields", () => {
  const big = "z".repeat(300);
  assert.equal(checkWriteSize("apply_patch", { patch: big }, 100)?.block, true);
  assert.equal(checkWriteSize("apply_patch", { input: big }, 100)?.block, true);
  assert.equal(checkWriteSize("apply_patch", { file_path: "a.txt" }, 100), null, "no payload -> pass through");
});

test("checkWriteSize covers multi_edit via the edits[] array", () => {
  const result = checkWriteSize(
    "multi_edit",
    { edits: [{ new_string: "x".repeat(60) }, { new_string: "y".repeat(60) }] },
    100,
  );
  assert.equal(result?.block, true); // 60 + "\n" + 60 = 121 > 100
});

test("collectWriteContent gathers apply_patch and multi_edit payloads", () => {
  assert.equal(collectWriteContent({ patch: "P", input: "I" }), "P\nI");
  assert.equal(collectWriteContent({ edits: [{ new_string: "a" }, { content: "b" }] }), "a\nb");
});

test("resolveMaxWriteBytesFromPolicy falls back to the default and honors overrides", () => {
  assert.equal(resolveMaxWriteBytesFromPolicy(null), DEFAULT_MAX_WRITE_BYTES);
  assert.equal(resolveMaxWriteBytesFromPolicy(undefined), DEFAULT_MAX_WRITE_BYTES);
  assert.equal(resolveMaxWriteBytesFromPolicy({}), DEFAULT_MAX_WRITE_BYTES);
  assert.equal(resolveMaxWriteBytesFromPolicy({ maxWriteBytes: 1234 }), 1234);
  assert.equal(resolveMaxWriteBytesFromPolicy({ maxWriteBytes: -5 }), DEFAULT_MAX_WRITE_BYTES);
});
