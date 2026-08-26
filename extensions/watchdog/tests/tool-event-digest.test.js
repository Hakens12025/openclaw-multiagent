import test from "node:test";
import assert from "node:assert/strict";

import { digestToolArgs, digestToolResult } from "../lib/evidence/tool-event-digest.js";

test("write digest keeps path/bytes/hash and never raw content", () => {
  const digest = digestToolArgs("write", { path: "/tmp/r.md", content: "hello world" });
  assert.equal(digest.path, "/tmp/r.md");
  assert.equal(digest.bytes, 11);
  assert.match(digest.hash, /^[0-9a-f]{64}$/);
  assert.equal("content" in digest, false);
});

test("bash digest clips command and redacts api keys", () => {
  const digest = digestToolArgs("bash", {
    command: `curl -H "Authorization: sk-${"a".repeat(24)}" https://x`,
  });
  assert.ok(digest.command.includes("[REDACTED]"));
  assert.equal(digest.command.includes("sk-a"), false);
});

test("unknown tools fall back to key names only", () => {
  const digest = digestToolArgs("mystery_tool", { secretPayload: "xxx", n: 1 });
  assert.deepEqual(digest, { keys: ["secretPayload", "n"] });
});

test("result digest records error text (redacted) or byte count", () => {
  assert.match(digestToolResult({ error: "boom" }).error, /boom/);
  const ok = digestToolResult({ result: { content: [{ type: "text", text: "abcd" }] } });
  assert.ok(Number.isFinite(ok.bytes));
});
