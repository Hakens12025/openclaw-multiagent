/**
 * artifact-flow.test.js — 产物随 contract 整包流转 + 独立留存（多文件）
 *
 * 用户核心设计：上游产物独立留存（不被覆盖）+ 整包（全部文件）投进下一环 inbox。
 * 产物可能是多个文件，系统搬 outbox 全部产物文件，不是单 md。
 * 决策：docs/decision-dual-file-package-flow-2026-05-31.md
 *
 * 覆盖：
 *   1. saveAgentArtifact：多文件整包落 artifacts/<cid>/<producer>/ + manifest.json
 *   2. saveAgentArtifact：每个 producer 独立一包，不覆盖别的 producer
 *   3. saveAgentArtifact：无产物 / 缺参 → no-op；非法入参 → 不抛
 *   4. copyUpstreamArtifactsToInbox：上游整包（多文件）→ inbox/upstream/<producer>/ 全部出现 + packages 返回
 *   5. copyUpstreamArtifactsToInbox：无上游（root）/ 上游无包 → 不复制
 *   6. copyUpstreamArtifactsToInbox：缺参 → no-op；不抛
 *   7. 接入护栏：preserve_artifact 在 graph_route 之前 + 传 artifactPaths + routeInbox 写 upstreamPackages 指针 + wake 不再嵌产物
 *
 * 叶子/上游判定走真实 graph（loadGraph）；fixtures 用 graph 里真实的
 * planner→worker 边（planner 是 worker 的上游）。临时 contractId 不污染拓扑。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  saveAgentArtifact,
  copyUpstreamArtifactsToInbox,
  artifactPackageDir,
  artifactManifestPath,
  artifactDir,
} from "../lib/lifecycle/artifact-store.js";
import { buildWakeMessage } from "../lib/routing/dispatch-graph-policy.js";
import { loadGraph, getEdgesTo } from "../lib/agent/agent-graph.js";
import { saveGraph } from "../lib/agent/agent-graph-mutations.js";
import { agentWorkspace } from "../lib/state-agent-helpers.js";
import { AGENT_END_MAIN_STAGES } from "../lib/lifecycle/agent-end-stage-definitions.js";

const OC_ROOT = join(homedir(), ".openclaw");
const OUTPUT_DIR = join(OC_ROOT, "control-plane", "output");

// 在 control-plane/output/ 写若干产物文件，返回它们的绝对路径（模拟 collect 后的 materialized 路径）。
async function writeOutputs(cid, entries) {
  await mkdir(OUTPUT_DIR, { recursive: true });
  const paths = [];
  for (const [name, body] of entries) {
    const p = join(OUTPUT_DIR, `${cid}-${name}`);
    await writeFile(p, body, "utf8");
    paths.push(p);
  }
  return paths;
}

function readManifest(cid, agentId) {
  return JSON.parse(readFileSync(artifactManifestPath(cid, agentId), "utf8"));
}

// ── 1. saveAgentArtifact 多文件整包 + manifest ────────────────────────────────

test("saveAgentArtifact：多文件整包落 artifacts/<cid>/<producer>/ + manifest.json", async () => {
  const cid = `tc-art-pkg-${Date.now()}`;
  const [reportPath, dataPath] = await writeOutputs(cid, [
    [`report.md`, "PLANNER 计划正文"],
    [`data.json`, '{"k":1}'],
  ]);
  try {
    const result = await saveAgentArtifact({
      contractId: cid,
      agentId: "planner",
      artifactPaths: [reportPath, dataPath],
      primaryOutputPath: reportPath,
    });
    assert.equal(result.saved, true);
    assert.equal(result.dir, artifactPackageDir(cid, "planner"));
    // 两个产物文件都整包落盘（basename 命名）
    assert.equal(existsSync(join(result.dir, `${cid}-report.md`)), true, "report 应落包");
    assert.equal(existsSync(join(result.dir, `${cid}-data.json`)), true, "data 应落包");
    assert.equal(readFileSync(join(result.dir, `${cid}-report.md`), "utf8"), "PLANNER 计划正文");
    // manifest 列清单 + 主交付物
    const m = readManifest(cid, "planner");
    assert.equal(m.contractId, cid);
    assert.equal(m.producer, "planner");
    assert.deepEqual([...m.files].sort(), [`${cid}-data.json`, `${cid}-report.md`].sort());
    assert.equal(m.primary, `${cid}-report.md`, "primary 应是显式 primaryOutputPath");
    assert.ok(typeof m.producedAt === "string" && m.producedAt.length > 0, "manifest 应有 producedAt");
  } finally {
    await rm(reportPath, { force: true });
    await rm(dataPath, { force: true });
    await rm(artifactDir(cid), { recursive: true, force: true });
  }
});

test("saveAgentArtifact：无显式 primary → 优先 .md，再退首个文件", async () => {
  const cid = `tc-art-prim-${Date.now()}`;
  const [aPath, mdPath] = await writeOutputs(cid, [
    [`a.json`, "{}"],
    [`b.md`, "# md"],
  ]);
  try {
    await saveAgentArtifact({ contractId: cid, agentId: "planner", artifactPaths: [aPath, mdPath] });
    assert.equal(readManifest(cid, "planner").primary, `${cid}-b.md`, "无显式 primary 应优先 .md");
  } finally {
    await rm(aPath, { force: true });
    await rm(mdPath, { force: true });
    await rm(artifactDir(cid), { recursive: true, force: true });
  }
});

// ── 2. 每个 producer 独立一包，不覆盖 ──────────────────────────────────────────

test("saveAgentArtifact：每个 producer 独立一包，不覆盖别的 producer", async () => {
  const cid = `tc-art-noover-${Date.now()}`;
  const [plannerSrc] = await writeOutputs(cid, [[`p.md`, "PLANNER 产物"]]);
  const [workerSrc] = await writeOutputs(cid, [[`w.md`, "WORKER 产物"]]);
  try {
    await saveAgentArtifact({ contractId: cid, agentId: "planner", artifactPaths: [plannerSrc] });
    await saveAgentArtifact({ contractId: cid, agentId: "worker", artifactPaths: [workerSrc] });
    assert.equal(readManifest(cid, "planner").producer, "planner");
    assert.equal(readManifest(cid, "worker").producer, "worker");
    assert.equal(readFileSync(join(artifactPackageDir(cid, "planner"), `${cid}-p.md`), "utf8"), "PLANNER 产物", "planner 包不应被 worker 覆盖");
    assert.equal(readFileSync(join(artifactPackageDir(cid, "worker"), `${cid}-w.md`), "utf8"), "WORKER 产物");
  } finally {
    await rm(plannerSrc, { force: true });
    await rm(workerSrc, { force: true });
    await rm(artifactDir(cid), { recursive: true, force: true });
  }
});

// ── 3. saveAgentArtifact 兜底 ──────────────────────────────────────────────────

test("saveAgentArtifact：无产物 / 缺参 → no-op；非法入参 → 不抛", async () => {
  const cid = `tc-art-noop-${Date.now()}`;
  const EMPTY = { saved: false, dir: null, files: [], manifestPath: null };
  // artifactPaths 指向不存在文件
  assert.deepEqual(
    await saveAgentArtifact({ contractId: cid, agentId: "planner", artifactPaths: [join(OUTPUT_DIR, `__no_${cid}__.md`)] }),
    EMPTY,
  );
  // 空 artifactPaths
  assert.deepEqual(await saveAgentArtifact({ contractId: cid, agentId: "planner", artifactPaths: [] }), EMPTY);
  // 缺参
  assert.deepEqual(await saveAgentArtifact({ agentId: "planner", artifactPaths: ["/x"] }), EMPTY);
  assert.deepEqual(await saveAgentArtifact({ contractId: cid, artifactPaths: ["/x"] }), EMPTY);
  assert.deepEqual(await saveAgentArtifact({ contractId: cid, agentId: "planner" }), EMPTY);
  assert.deepEqual(await saveAgentArtifact({}), EMPTY);
  // 非法入参类型不抛
  assert.deepEqual(await saveAgentArtifact({ contractId: cid, agentId: "planner", artifactPaths: 12345 }), EMPTY);
});

// ── 4. copyUpstreamArtifactsToInbox 上游整包流入 ──────────────────────────────

test("copyUpstreamArtifactsToInbox：上游整包（多文件）→ inbox/upstream/<producer>/ 全部出现 + packages 返回", async () => {
  // 自建 graph fixture：planner→worker（planner 是 worker 的上游）。
  // 不依赖 live 拓扑——live 拓扑可被有意更改；测试自建 fixture + 用后恢复，保证隔离。
  const originalGraph = await loadGraph();
  const cid = `tc-art-up-${Date.now()}`;
  const upstreamRoot = join(agentWorkspace("worker"), "inbox", "upstream");
  let reportPath;
  let dataPath;
  try {
    await saveGraph({ edges: [{ from: "planner", to: "worker", label: "test-upstream" }] });
    [reportPath, dataPath] = await writeOutputs(cid, [
      [`report.md`, "PLANNER 给下游的计划"],
      [`data.json`, '{"n":2}'],
    ]);
    await rm(upstreamRoot, { recursive: true, force: true });
    // planner 多文件整包独立保存
    await saveAgentArtifact({ contractId: cid, agentId: "planner", artifactPaths: [reportPath, dataPath], primaryOutputPath: reportPath });
    // worker 启动 → 上游 planner 整包流入 worker inbox/upstream/planner/
    const result = await copyUpstreamArtifactsToInbox({ contractId: cid, agentId: "worker" });
    assert.ok(result.copied.includes("planner"), "应复制 planner 上游包");
    assert.deepEqual(result.packages, ["upstream/planner/"], "packages 应为相对 inbox 的包路径");
    const pkgDir = join(upstreamRoot, "planner");
    assert.equal(existsSync(join(pkgDir, `${cid}-report.md`)), true, "report 应整包流入");
    assert.equal(existsSync(join(pkgDir, `${cid}-data.json`)), true, "data 应整包流入");
    assert.equal(existsSync(join(pkgDir, "manifest.json")), true, "manifest 应随包流入（agent 据此知道清单/主交付物）");
    assert.equal(readFileSync(join(pkgDir, `${cid}-report.md`), "utf8"), "PLANNER 给下游的计划");
  } finally {
    await saveGraph(originalGraph);
    if (reportPath) await rm(reportPath, { force: true });
    if (dataPath) await rm(dataPath, { force: true });
    await rm(artifactDir(cid), { recursive: true, force: true });
    await rm(upstreamRoot, { recursive: true, force: true });
  }
});

// ── 5. 无上游 / 上游无包 → 不复制 ──────────────────────────────────────────────

test("copyUpstreamArtifactsToInbox：无上游（root agent）→ 不复制", async () => {
  const graph = await loadGraph();
  const allFrom = new Set(graph.edges.map((e) => e.from));
  const root = [...allFrom].find((id) => getEdgesTo(graph, id).length === 0);
  if (!root) {
    assert.ok(true, "当前 graph 无根节点，跳过");
    return;
  }
  const cid = `tc-art-root-${Date.now()}`;
  assert.deepEqual(await copyUpstreamArtifactsToInbox({ contractId: cid, agentId: root }), { copied: [], packages: [] });
});

test("copyUpstreamArtifactsToInbox：上游存在但本环无包 → 不复制", async () => {
  const cid = `tc-art-nopkg-${Date.now()}`;
  const upstreamRoot = join(agentWorkspace("worker"), "inbox", "upstream");
  await rm(upstreamRoot, { recursive: true, force: true });
  try {
    assert.deepEqual(await copyUpstreamArtifactsToInbox({ contractId: cid, agentId: "worker" }), { copied: [], packages: [] });
    assert.equal(existsSync(join(upstreamRoot, "planner")), false);
  } finally {
    await rm(upstreamRoot, { recursive: true, force: true });
  }
});

// ── 6. copyUpstream 缺参兜底 ───────────────────────────────────────────────────

test("copyUpstreamArtifactsToInbox：缺参 → no-op；不抛", async () => {
  assert.deepEqual(await copyUpstreamArtifactsToInbox({ agentId: "worker" }), { copied: [], packages: [] });
  assert.deepEqual(await copyUpstreamArtifactsToInbox({ contractId: "tc-x" }), { copied: [], packages: [] });
  assert.deepEqual(await copyUpstreamArtifactsToInbox({}), { copied: [], packages: [] });
});

// ── 7. 接入静态护栏 ────────────────────────────────────────────────────────────

test("agent-end MAIN：preserve_artifact 在 extract_output_markers 之后、graph_route 之前", () => {
  const ids = AGENT_END_MAIN_STAGES.map((s) => s.id);
  const preserveIdx = ids.indexOf("preserve_artifact");
  const graphRouteIdx = ids.indexOf("graph_route");
  const extractIdx = ids.indexOf("extract_output_markers");
  assert.ok(preserveIdx >= 0, "MAIN_STAGES 应含 preserve_artifact 阶段");
  assert.ok(graphRouteIdx >= 0, "MAIN_STAGES 应含 graph_route 阶段");
  assert.ok(extractIdx < preserveIdx, "preserve_artifact 应在 extract_output_markers 之后（产出件已就绪）");
  assert.ok(preserveIdx < graphRouteIdx, "preserve_artifact 必须在 graph_route 之前（派发前整包存好，下游可流入）");
});

test("agent-end-stage-definitions：preserve_artifact 传 artifactPaths（整包）、回退 primaryOutputPath、包 try/catch", async () => {
  const src = await readFile(new URL("../lib/lifecycle/agent-end-stage-definitions.js", import.meta.url), "utf8");
  assert.match(src, /id:\s*"preserve_artifact"/, "应有 preserve_artifact 阶段");
  assert.match(src, /saveAgentArtifact/, "preserve_artifact 应调 saveAgentArtifact");
  assert.match(src, /artifactPaths/, "应传整包 artifactPaths（非单文件）");
  // 单交付物（写到 contract.output、不走 outbox 的 WebUI 链路）回退打包
  assert.match(src, /artifactPaths\.length === 0 && primaryOutputPath/, "artifactPaths 为空时应回退到 primaryOutputPath（单交付物也打包流转）");
  assert.match(src, /try\s*\{[\s\S]*saveAgentArtifact[\s\S]*\}\s*catch/, "saveAgentArtifact 应包在 try/catch 内");
});

test("agent-end-transport：cleanup_transport 不再调 saveAgentArtifact（已前移）", async () => {
  const src = await readFile(new URL("../lib/lifecycle/agent-end-transport.js", import.meta.url), "utf8");
  assert.doesNotMatch(src, /await saveAgentArtifact\(/, "cleanup_transport 不应再调 saveAgentArtifact");
  assert.match(src, /snapshotOutputToTrace/, "snapshotOutputToTrace 应保留在 cleanup_transport");
});

test("runtime-mailbox：routeInbox 接入 copyUpstream + 写 upstreamPackages 指针 + try/catch", async () => {
  const src = await readFile(new URL("../runtime-mailbox.js", import.meta.url), "utf8");
  assert.match(src, /copyUpstreamArtifactsToInbox/, "routeInbox 应接入 copyUpstreamArtifactsToInbox");
  assert.match(src, /upstreamPackages/, "应在 contract.json 写 upstreamPackages 指针");
  const handlerIdx = src.indexOf("handler.routeInbox");
  const copyIdx = src.indexOf("copyUpstreamArtifactsToInbox(");
  assert.ok(handlerIdx >= 0 && copyIdx >= 0 && handlerIdx < copyIdx, "上游复制应在 handler.routeInbox 之后");
  assert.match(src, /try\s*\{[\s\S]*copyUpstreamArtifactsToInbox[\s\S]*\}\s*catch/, "上游复制应包在 try/catch 内");
});

test("dispatch-graph-policy：buildWakeMessage 回归 base（不再嵌上游产物，agent 只读自己 inbox）", async () => {
  // 行为：只返回原始续作指令
  assert.equal(buildWakeMessage("tc-wake-x"), "Continue the current contract: tc-wake-x.");
  // 静态护栏：嵌入逻辑已撤除
  const src = await readFile(new URL("../lib/routing/dispatch-graph-policy.js", import.meta.url), "utf8");
  assert.doesNotMatch(src, /WAKE_UPSTREAM_CAP/, "wake 嵌入上限常量应已删除");
  assert.doesNotMatch(src, /【上游产物/, "wake 不应再嵌上游产物正文");
  assert.doesNotMatch(src, /artifactPath\b/, "dispatch-graph-policy 不应再引 artifactPath");
});
