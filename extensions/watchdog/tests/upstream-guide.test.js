import test from "node:test";
import assert from "node:assert/strict";

import {
  UPSTREAM_GUIDE_FILE,
  MISSING_MARKER_FILE,
  GUIDE_HEAD_CHARS,
  truncateHead,
  buildUpstreamGuide,
  buildMissingMarker,
} from "../lib/delivery/upstream-guide.js";

test("导出常量：导览/缺料标记文件名固定", () => {
  assert.equal(UPSTREAM_GUIDE_FILE, "UPSTREAM_GUIDE.md");
  assert.equal(MISSING_MARKER_FILE, "_MISSING.md");
});

test("truncateHead：短文本原样，超长截断并提示剩余字符数", () => {
  assert.equal(truncateHead("abc", 10), "abc");
  const out = truncateHead("x".repeat(50), 10);
  assert.ok(out.startsWith("x".repeat(10)));
  assert.match(out, /truncated 40 more chars/);
  assert.equal(truncateHead(null), "");
});

test("buildUpstreamGuide：列 path + size + 截断 head，UTF-8 markdown", () => {
  const md = buildUpstreamGuide({ entries: [{ path: "planner/plan.md", size: 3_000_000, head: "PLAN HEAD 正文" }] });
  assert.match(md, /# UPSTREAM GUIDE/);
  assert.match(md, /## planner\/plan\.md {2}\(2\.86 MB\)/);
  assert.match(md, /PLAN HEAD 正文/);
  assert.match(md, /inbox\/upstream\/<producer>\//);
  assert.ok(md.endsWith("\n"));
});

test("buildUpstreamGuide：head 内部按 GUIDE_HEAD_CHARS 截断", () => {
  const head = "y".repeat(GUIDE_HEAD_CHARS + 200);
  assert.match(buildUpstreamGuide({ entries: [{ path: "p/f", size: 9, head }] }), /truncated 200 more chars/);
});

test("buildUpstreamGuide：空 entries / 缺 head 不抛", () => {
  assert.match(buildUpstreamGuide({ entries: [] }), /无上游文件/);
  assert.match(buildUpstreamGuide({ entries: [{ path: "p/f", size: 1 }] }), /head 不可读/);
  assert.ok(buildUpstreamGuide().endsWith("\n"));
});

test("buildMissingMarker：列出失败上游 + 原因，可见 markdown", () => {
  const md = buildMissingMarker({ agentId: "worker", contractId: "tc-1", failures: [{ producer: "planner", reason: "EACCES" }] });
  assert.match(md, /# MISSING UPSTREAM CONTEXT/);
  assert.match(md, /worker/);
  assert.match(md, /tc-1/);
  assert.match(md, /- \*\*planner\*\* — EACCES/);
  assert.ok(md.endsWith("\n"));
});

test("buildMissingMarker：空 failures / 缺参不抛", () => {
  assert.match(buildMissingMarker({ agentId: "w", contractId: "c", failures: [] }), /无缺失记录/);
  assert.ok(buildMissingMarker().endsWith("\n"));
});
