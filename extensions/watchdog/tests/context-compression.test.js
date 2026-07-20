import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_UPSTREAM_INBOX_BYTES,
  MANIFEST_HEAD_CHARS,
  computeContextBudgetPlan,
  truncateHead,
  buildCompressedManifest,
  buildMissingMarker,
} from "../lib/context-compression.js";

test("computeContextBudgetPlan：全部装得下 → 全 included，needsCompression=false", () => {
  const files = [{ path: "a.md", size: 10 }, { path: "b.json", size: 20 }];
  const plan = computeContextBudgetPlan({ files, maxBytes: 1000 });
  assert.deepEqual(plan.included.map((f) => f.path), ["a.md", "b.json"]);
  assert.deepEqual(plan.overflow, []);
  assert.equal(plan.needsCompression, false);
});

test("computeContextBudgetPlan：贪心累加，超预算的进 overflow（溢出不占用累计）", () => {
  const files = [{ path: "a", size: 600 }, { path: "b", size: 600 }, { path: "c", size: 300 }];
  const plan = computeContextBudgetPlan({ files, maxBytes: 1000 });
  assert.deepEqual(plan.included.map((f) => f.path), ["a", "c"]);
  assert.deepEqual(plan.overflow.map((f) => f.path), ["b"]);
  assert.equal(plan.needsCompression, true);
});

test("computeContextBudgetPlan：单文件 > 上限 → 必 overflow", () => {
  const plan = computeContextBudgetPlan({ files: [{ path: "big", size: 5_000_000 }], maxBytes: MAX_UPSTREAM_INBOX_BYTES });
  assert.deepEqual(plan.included, []);
  assert.deepEqual(plan.overflow.map((f) => f.path), ["big"]);
  assert.equal(plan.needsCompression, true);
});

test("computeContextBudgetPlan：保留输入顺序，决策确定", () => {
  const files = [{ path: "x", size: 400 }, { path: "y", size: 400 }, { path: "z", size: 400 }];
  const plan = computeContextBudgetPlan({ files, maxBytes: 1000 });
  assert.deepEqual(plan.included.map((f) => f.path), ["x", "y"]);
  assert.deepEqual(plan.overflow.map((f) => f.path), ["z"]);
});

test("computeContextBudgetPlan：默认上限 + 非法入参兜底", () => {
  assert.deepEqual(computeContextBudgetPlan(), { included: [], overflow: [], needsCompression: false });
  assert.deepEqual(computeContextBudgetPlan({}), { included: [], overflow: [], needsCompression: false });
  assert.deepEqual(computeContextBudgetPlan({ files: null }), { included: [], overflow: [], needsCompression: false });
  const plan = computeContextBudgetPlan({ files: [{ path: "a", size: "oops" }, { path: "b" }, null, 42] });
  assert.deepEqual(plan.included.map((f) => f.path), ["a", "b"]);
  assert.equal(plan.included[0].size, 0);
  const p2 = computeContextBudgetPlan({ files: [{ path: "a", size: 1 }], maxBytes: -5 });
  assert.equal(p2.needsCompression, false);
});

test("truncateHead：短文本原样，超长截断并提示剩余字符数", () => {
  assert.equal(truncateHead("abc", 10), "abc");
  const out = truncateHead("x".repeat(50), 10);
  assert.ok(out.startsWith("x".repeat(10)));
  assert.match(out, /truncated 40 more chars/);
  assert.equal(truncateHead(null), "");
});

test("buildCompressedManifest：列 path + size + 截断 head，UTF-8 markdown", () => {
  const md = buildCompressedManifest({ producer: "planner", entries: [{ path: "plan.md", size: 3_000_000, head: "PLAN HEAD 正文" }], maxBytes: MAX_UPSTREAM_INBOX_BYTES });
  assert.match(md, /# COMPRESSED UPSTREAM CONTEXT — planner/);
  assert.match(md, /## plan\.md {2}\(2\.86 MB\)/);
  assert.match(md, /PLAN HEAD 正文/);
  assert.match(md, /control-plane\/artifacts\/<contractId>\/planner\//);
  assert.ok(md.endsWith("\n"));
});

test("buildCompressedManifest：head 内部按 MANIFEST_HEAD_CHARS 截断", () => {
  const head = "y".repeat(MANIFEST_HEAD_CHARS + 200);
  assert.match(buildCompressedManifest({ producer: "p", entries: [{ path: "f", size: 9, head }] }), /truncated 200 more chars/);
});

test("buildCompressedManifest：空 entries / 缺 head 不抛", () => {
  assert.match(buildCompressedManifest({ producer: "p", entries: [] }), /无溢出文件/);
  assert.match(buildCompressedManifest({ producer: "p", entries: [{ path: "f", size: 1 }] }), /head 不可读/);
  assert.ok(buildCompressedManifest().endsWith("\n"));
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
