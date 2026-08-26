// tests/batch4-seal-semantics.test.js — 批④刀3 行为锁(seal 语义/多跳封条/残件隔离/
// 目录过滤/真值域同域判定)。
//   ①D1 crash-retry:崩溃轮(turnSucceeded=false)采集不写 seal、不被既有封条短路;
//     retry 轮真交付重采封包,交付凭据=retry 轮产物。
//   ②D1 陈旧封条:seal.contractId ≠ 本轮绑定合约 → 读端失效,本轮正常采集重封覆写。
//   ③D2 多跳同 cid 多封条:无 hint 取 collectedAt 最新者;assignee hint 锁定末跳。
//   ④D3+D4 残件隔离:staging 残件进 .migrated/,点前缀/目录条目一律不入采集与 seal。
//   ⑤D6 真值域:生产对生产/沙箱对沙箱放行,混域(真 workspace+种子树根)skip 切链。
//   ⑥-⑩ D8 封条身份三绑定 + 树内鲜度过滤 + 收口逐级回退:
//   ⑥回投/loop 同 cid 新会话轮:轮2 采集重封(轮1 seal 让位),轮2 声明/产物生效。
//   ⑦借道轮(D7 留链 + 直达信封)零触碰:宿主 seal 原样在场,借道轮零封;
//     双向鲜度隔离(借道轮收不到宿主产物,宿主下轮收不到借道残件)。
//   ⑧读端归属核对:seal.contractId 错配的封条 findSealedOutbox 一律跳过。
//   ⑨树内鲜度过滤:旧 mtime 文件出采集视野出 seal,文件原地留树。
//   ⑩seal 缺席树轮:收口逐级回退到观测 primaryPath,contract.output 缺席零短路。
//
// Run: node --test tests/batch4-seal-semantics.test.js

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, utimes, writeFile } from "node:fs/promises";
import { existsSync, mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { registerRuntimeAgents } from "../lib/agent/agent-identity.js";
import { bindParticipantOutbox, isSameTruthDomain } from "../lib/routing/mailbox/runtime-mailbox.js";
import { collectWorkerOutbox } from "../lib/routing/mailbox/runtime-mailbox-outbox-handlers.js";
import { persistContractById } from "../lib/contract/contracts.js";
import { findSealedOutbox, readOutboxSeal } from "../lib/archive/outbox-seal.js";
import { resolvePhysicalWorkspacePath } from "../lib/state/state-agent-helpers.js";
import { resolveTerminalOutcome } from "../lib/contract/terminal-outcome.js";
import { CONTRACT_STATUS } from "../lib/core/runtime-status.js";

const logger = { info() {}, warn() {}, error() {} };
const sandbox = mkdtempSync(join(tmpdir(), "batch4-seal-semantics-"));

function wsFor(agentId) {
  return join(sandbox, "workspaces", agentId);
}

function registerSandboxAgents(ids) {
  registerRuntimeAgents({
    agents: {
      list: ids.map((id) => ({
        id,
        role: "executor",
        workspace: wsFor(id),
        model: { primary: "demo/worker" },
      })),
    },
  });
}

let seq = 0;
async function seedContract({ agentId, contractId, output = null, lineage = null }) {
  seq += 1;
  const contract = {
    id: contractId,
    task: "seal 语义行为锁",
    assignee: agentId,
    status: "running",
    createdAt: Date.now() - 1000,
    ...(output ? { output } : {}),
    lineage: lineage || { threadId: "t-b4seal", runId: `r-${Date.now()}-${seq}` },
  };
  await persistContractById(contract, logger);
  return contract;
}

test("①D1 崩溃轮不封包,retry 轮重采封真交付(crash-retry 幂等短路病灶锁)", async () => {
  const agentId = "b4seal-crash-agent";
  registerSandboxAgents([agentId]);
  const ws = wsFor(agentId);
  const outboxDir = join(ws, "outbox");
  const cid = `TC-B4SEAL-CRASH-${Date.now()}`;
  const contract = await seedContract({ agentId, contractId: cid });
  const bind = await bindParticipantOutbox({ agentId, workspace: ws, contractId: cid, logger });
  assert.equal(bind.linked, true);
  const tree = resolvePhysicalWorkspacePath(bind.treeOutboxDir);

  // 轮1:半截草稿后崩溃 → agent_end(success=false) 采集,产物留树、零封条
  await writeFile(join(outboxDir, "draft.md"), "# 半截草稿(崩溃时)\n", "utf8");
  const r1 = await collectWorkerOutbox({
    agentId,
    outboxDir,
    files: ["draft.md"],
    logger,
    boundContractId: cid,
    sessionKey: `agent:${agentId}:round1`,
    turnSucceeded: false,
  });
  assert.equal(r1.collected, true, "崩溃轮采集照常收观测证据");
  assert.equal(readOutboxSeal(tree), null, "崩溃轮零封条 — 封条在场即 crash-retry 短路回归");

  // 轮2(crash-retry 重唤醒):真交付 + 显式声明 completed → 正常采集封包
  await writeFile(join(outboxDir, "final-report.md"), "# 真交付\n完整成果\n", "utf8");
  await writeFile(join(outboxDir, "runtime_result.json"), JSON.stringify({
    version: 1,
    status: "completed",
    summary: "retry done",
    primaryArtifactPath: "final-report.md",
  }), "utf8");
  const r2 = await collectWorkerOutbox({
    agentId,
    outboxDir,
    files: ["draft.md", "final-report.md", "runtime_result.json"],
    logger,
    boundContractId: cid,
    sessionKey: `agent:${agentId}:round2`,
  });
  assert.equal(r2.sealed, undefined, "retry 轮走正常采集而非封条回放");
  const seal = readOutboxSeal(tree);
  assert.ok(seal, "retry 轮成功收官必须封包");
  assert.equal(seal.primary, "final-report.md", "封条 primary = retry 轮真交付");
  assert.equal(seal.declaredStatus, "completed");

  const outcome = await resolveTerminalOutcome({
    trackingState: { contract },
    contractData: contract,
    executionObservation: r2,
    logger,
  });
  assert.equal(outcome.terminalStatus, CONTRACT_STATUS.COMPLETED);
  assert.equal(
    resolvePhysicalWorkspacePath(outcome.terminalOutcome.artifact),
    join(tree, "final-report.md"),
    "交付凭据必须指 retry 轮真交付 — 指向 draft.md 即崩溃轮封条吞交付回归",
  );
});

test("②D1 陈旧封条(contractId 错配)→ 读端失效,本轮正常采集重封覆写", async () => {
  const agentId = "b4seal-stale-agent";
  registerSandboxAgents([agentId]);
  const ws = wsFor(agentId);
  const outboxDir = join(ws, "outbox");
  const cid = `TC-B4SEAL-STALESEAL-${Date.now()}`;
  await seedContract({ agentId, contractId: cid });
  const bind = await bindParticipantOutbox({ agentId, workspace: ws, contractId: cid, logger });
  assert.equal(bind.linked, true);
  const tree = resolvePhysicalWorkspacePath(bind.treeOutboxDir);

  // staging 残链场景:树目录里躺着别的合约的封条
  await writeFile(join(tree, "seal.json"), JSON.stringify({
    contractId: "TC-SOMEONE-ELSE",
    collectedAt: Date.now() - 60_000,
    primary: "ghost.md",
    files: ["ghost.md"],
    declaredStatus: "completed",
  }), "utf8");
  await writeFile(join(outboxDir, "real.md"), "# 本轮真产物\n", "utf8");

  const result = await collectWorkerOutbox({
    agentId,
    outboxDir,
    files: ["real.md", "seal.json"],
    logger,
    boundContractId: cid,
    sessionKey: `agent:${agentId}:fresh`,
  });
  assert.equal(result.sealed, undefined, "错配封条必须失效,采集走正常路");
  const seal = readOutboxSeal(tree);
  assert.equal(seal?.contractId, cid, "重新封包归属本轮绑定合约");
  assert.equal(seal?.primary, "real.md", "封条 primary = 本轮真产物,幽灵条目出局");
});

test("③D2 多跳同 cid:无 hint 取 collectedAt 最新封条,assignee hint 锁定末跳", async () => {
  const first = "a-upstream-agent"; // 字典序在前 = 上游中间跳
  const last = "z-terminal-agent"; // 末跳,真交付者
  registerSandboxAgents([first, last]);
  const cid = `TC-B4SEAL-MULTI-${Date.now()}`;
  const lineage = { threadId: "t-b4seal-m", runId: `r-m-${Date.now()}` };
  const contract = await seedContract({ agentId: first, contractId: cid, lineage });

  // 跳1:上游采集(中间产物封条,collectedAt 较早)
  await bindParticipantOutbox({ agentId: first, workspace: wsFor(first), contractId: cid, logger });
  await writeFile(join(wsFor(first), "outbox", "intermediate.md"), "# 中间产物\n", "utf8");
  await collectWorkerOutbox({
    agentId: first,
    outboxDir: join(wsFor(first), "outbox"),
    files: ["intermediate.md"],
    logger,
    boundContractId: cid,
    sessionKey: "s1",
  });
  // 时间序可分辨:末跳封条严格晚于上游
  await new Promise((r) => setTimeout(r, 10));

  // 跳2(末跳):下游采集(最终交付封条)
  await bindParticipantOutbox({ agentId: last, workspace: wsFor(last), contractId: cid, logger });
  await writeFile(join(wsFor(last), "outbox", "final.md"), "# 最终交付\n", "utf8");
  const r2 = await collectWorkerOutbox({
    agentId: last,
    outboxDir: join(wsFor(last), "outbox"),
    files: ["final.md"],
    logger,
    boundContractId: cid,
    sessionKey: "s2",
  });

  const noHint = findSealedOutbox(cid);
  assert.equal(noHint?.agentId, last, "无 hint 必须取 collectedAt 最新者(末跳),字典序即病灶");
  assert.ok(noHint?.primaryPath?.endsWith("final.md"));
  const hinted = findSealedOutbox(cid, { agentId: first });
  assert.equal(hinted?.agentId, first, "hint 给定且封条在场 → 用 hint 参与者");

  const terminalContract = { ...contract, assignee: last };
  const outcome = await resolveTerminalOutcome({
    trackingState: { contract: terminalContract },
    contractData: terminalContract,
    executionObservation: r2,
    logger,
  });
  assert.equal(outcome.terminalStatus, CONTRACT_STATUS.COMPLETED);
  assert.ok(
    String(outcome.terminalOutcome.artifact || "").endsWith("final.md"),
    "终局交付凭据 = 末跳 final.md — 取上游中间产物即多跳封条回归",
  );
});

test("④D3+D4 残件进 .migrated/ 隔离,点前缀/目录条目零入采集与 seal", async () => {
  const agentId = "b4seal-quarantine-agent";
  registerSandboxAgents([agentId]);
  const ws = wsFor(agentId);
  const outboxDir = join(ws, "outbox");
  await mkdir(outboxDir, { recursive: true });

  // 上一轮早退残件:mtime = 10 分钟前
  const stalePath = join(outboxDir, "stale-report.md");
  await writeFile(stalePath, "上一轮旧结论(与本合约无关)", "utf8");
  const oldSec = (Date.now() - 10 * 60 * 1000) / 1000;
  await utimes(stalePath, oldSec, oldSec);
  await mkdir(join(outboxDir, ".stale"), { recursive: true });
  await writeFile(join(outboxDir, ".stale", "old.md"), "隔离残件", "utf8");

  const cid = `TC-B4SEAL-QUAR-${Date.now()}`;
  const contract = await seedContract({ agentId, contractId: cid, output: join(ws, "final.md") });
  const bind = await bindParticipantOutbox({ agentId, workspace: ws, contractId: cid, logger });
  assert.equal(bind.linked, true);
  const tree = resolvePhysicalWorkspacePath(bind.treeOutboxDir);
  assert.equal(existsSync(join(tree, ".migrated", "stale-report.md")), true, "残件归 .migrated/ 隔离区");
  assert.equal(existsSync(join(tree, "stale-report.md")), false, "残件与树 outbox 根隔离");

  // 本轮 agent 零产出,采集视野 = readdir(outbox) = [".migrated"]
  const collected = await collectWorkerOutbox({
    agentId,
    outboxDir,
    files: [".migrated"],
    logger,
    sessionStartMs: Date.now(),
    boundContractId: cid,
    sessionKey: `agent:${agentId}:quar`,
  });
  assert.deepEqual(collected.files || [], [], "点前缀/目录条目零入采集");
  const seal = readOutboxSeal(tree);
  assert.ok(seal, "零产出轮封空包(采集事实照记)");
  assert.deepEqual(seal.files, [], "seal.files 与采集同筛,残件/目录零入封");
  assert.equal(seal.primary, null);

  const outcome = await resolveTerminalOutcome({
    trackingState: { contract },
    contractData: contract,
    executionObservation: collected,
    logger,
  });
  assert.equal(outcome.terminalStatus, CONTRACT_STATUS.FAILED, "残件冒充交付被隔离后,零产出轮按事实判失败");
});

test("⑤D6 真值域同域判定:生产/沙箱放行,混域 skip 切链 fail-open", async () => {
  // 谓词三态(直测)
  // 店根门卫(§13)语义:测试进程树根由门卫沙箱化,不再依赖 env 在场;
  // 生产态模拟只需摘 NODE_TEST_CONTEXT(非测试进程+无种子=生产根)。
  const realishWorkspace = join(homedir(), ".openclaw", "workspaces", "b4seal-phantom-agent");
  const savedTestCtx = process.env.NODE_TEST_CONTEXT;
  try {
    delete process.env.NODE_TEST_CONTEXT;
    assert.equal(isSameTruthDomain(realishWorkspace), true, "生产对生产同域");
    assert.equal(isSameTruthDomain(wsFor("any-agent")), true, "生产树根下任意 workspace 同域");
  } finally {
    if (savedTestCtx === undefined) delete process.env.NODE_TEST_CONTEXT;
    else process.env.NODE_TEST_CONTEXT = savedTestCtx;
  }
  assert.equal(isSameTruthDomain(wsFor("any-agent")), true, "门卫沙箱树根 + tmp workspace = 沙箱对沙箱同域");
  assert.equal(isSameTruthDomain(realishWorkspace), false, "门卫沙箱树根 + 真 workspace = 混域");

  // bind 层:混域 skip 切链,真 workspace 零触碰(链/目录都不建)
  const agentId = "b4seal-mixed-agent";
  const cid = `TC-B4SEAL-MIXED-${Date.now()}`;
  await seedContract({ agentId, contractId: cid });
  const bind = await bindParticipantOutbox({
    agentId,
    workspace: realishWorkspace,
    contractId: cid,
    logger,
  });
  assert.equal(bind.linked, false, "混域切链会把真 outbox 链进种子树 — npm 清场即毁真产物");
  assert.equal(bind.reason, "truth_domain_mismatch");
  assert.equal(existsSync(join(realishWorkspace, "outbox")), false, "混域 fail-open 对真 workspace 零写入");
});

const TEN_MINUTES_MS = 10 * 60 * 1000;
async function backdate(path) {
  const oldSec = (Date.now() - TEN_MINUTES_MS) / 1000;
  await utimes(path, oldSec, oldSec);
}

test("⑥D8 回投/loop 同 cid 新会话轮:轮1封条让位,轮2 产物与声明重封", async () => {
  const agentId = "b4seal-loop-agent";
  registerSandboxAgents([agentId]);
  const ws = wsFor(agentId);
  const outboxDir = join(ws, "outbox");
  const cid = `TC-B4SEAL-LOOP-${Date.now()}`;
  await seedContract({ agentId, contractId: cid });
  const bind = await bindParticipantOutbox({ agentId, workspace: ws, contractId: cid, logger });
  assert.equal(bind.linked, true);
  const tree = resolvePhysicalWorkspacePath(bind.treeOutboxDir);

  // 轮1:产物 + 声明 completed → 封包(sessionKey s1)
  await writeFile(join(outboxDir, "round1.md"), "# 轮1 产物\n", "utf8");
  await writeFile(join(outboxDir, "runtime_result.json"), JSON.stringify({
    version: 1, status: "completed", summary: "round1 done", primaryArtifactPath: "round1.md",
  }), "utf8");
  const r1 = await collectWorkerOutbox({
    agentId, outboxDir, files: ["round1.md", "runtime_result.json"], logger,
    boundContractId: cid, sessionKey: `agent:${agentId}:s1`,
  });
  assert.equal(r1.collected, true);
  assert.equal(readOutboxSeal(tree)?.sessionKey, `agent:${agentId}:s1`);

  // 传送带回投轮2(同 cid 新会话):轮1文件退到会话起点之前,轮2 新产物 + 声明 failed
  await backdate(join(tree, "round1.md"));
  const round2StartMs = Date.now() - 1000;
  await writeFile(join(outboxDir, "round2.md"), "# 轮2 新产物\n", "utf8");
  await writeFile(join(outboxDir, "runtime_result.json"), JSON.stringify({
    version: 1, status: "failed", summary: "round2 blocked", primaryArtifactPath: "round2.md",
  }), "utf8");
  const r2 = await collectWorkerOutbox({
    agentId, outboxDir,
    files: ["round1.md", "round2.md", "runtime_result.json", "seal.json"],
    logger,
    boundContractId: cid,
    sessionKey: `agent:${agentId}:s2`,
    sessionStartMs: round2StartMs,
  });
  assert.equal(r2.sealed, undefined, "同合约异会话的采集走正常路 — 短路回放即轮2产物被吞回归");
  assert.ok((r2.files || []).includes("round2.md"), "轮2 新产物必须入采集");
  assert.equal((r2.files || []).includes("round1.md"), false, "轮1 产物出轮2采集视野");
  assert.equal(r2.stageRunResult?.status, "failed", "轮2 声明必须生效 — 冻结轮1 verdict 即回归");

  const seal2 = readOutboxSeal(tree);
  assert.equal(seal2?.sessionKey, `agent:${agentId}:s2`, "封条以轮2会话重封");
  assert.deepEqual(seal2?.files, ["round2.md"], "seal.files 随鲜度过滤结果");
  assert.equal(seal2?.primary, "round2.md");
  assert.equal(seal2?.declaredStatus, "failed");
  assert.equal(existsSync(join(tree, "round1.md")), true, "轮1 产物原地留树(零删除零搬运)");
});

test("⑦D8 借道轮零触碰:宿主封条原样在场,双向鲜度隔离", async () => {
  const agentId = "b4seal-usurp-agent";
  registerSandboxAgents([agentId]);
  const ws = wsFor(agentId);
  const outboxDir = join(ws, "outbox");
  const inboxDir = join(ws, "inbox");
  await mkdir(inboxDir, { recursive: true });
  const cid = `TC-B4SEAL-HOST-${Date.now()}`;
  await seedContract({ agentId, contractId: cid });
  const bind = await bindParticipantOutbox({ agentId, workspace: ws, contractId: cid, logger });
  assert.equal(bind.linked, true);
  const tree = resolvePhysicalWorkspacePath(bind.treeOutboxDir);

  // 宿主轮1:产物 + 封包
  await writeFile(join(outboxDir, "tc-report.md"), "# TC 交付正文\n", "utf8");
  const r1 = await collectWorkerOutbox({
    agentId, outboxDir, files: ["tc-report.md"], logger,
    boundContractId: cid, sessionKey: `agent:${agentId}:tc1`,
  });
  assert.equal(r1.collected, true);
  const hostSealBefore = JSON.stringify(readOutboxSeal(tree));
  assert.ok(hostSealBefore.includes(cid));

  // 中场直达信封 staging:无谱系轮撞上活跃合约的链 → D7 守卫留链
  const drId = "DR-B4SEAL-1";
  await writeFile(join(inboxDir, "contract.json"), JSON.stringify({
    id: drId, envelopeType: "direct_request", task: "review verdict return",
  }), "utf8");
  const bind2 = await bindParticipantOutbox({ agentId, workspace: ws, contractId: drId, logger });
  assert.equal(bind2.linked, false);
  assert.equal(bind2.reason, "active_contract_link_kept");

  // 借道轮:在宿主树目录上采集(身份 = DR ≠ 目录身份 TC)
  await backdate(join(tree, "tc-report.md"));
  const drStartMs = Date.now() - 1000;
  await writeFile(join(outboxDir, "dr-notes.md"), "direct round output\n", "utf8");
  const r2 = await collectWorkerOutbox({
    agentId, outboxDir,
    files: ["dr-notes.md", "tc-report.md", "seal.json"],
    logger,
    boundContractId: drId,
    sessionKey: `agent:${agentId}:dr1`,
    sessionStartMs: drStartMs,
  });
  assert.equal(r2.sealed, undefined, "宿主封条对借道轮零回放");
  assert.deepEqual(r2.files, ["dr-notes.md"], "借道轮收不到宿主产物(鲜度过滤)");
  assert.equal(JSON.stringify(readOutboxSeal(tree)), hostSealBefore,
    "宿主 seal 原封不动 — 被 unlink/重封即 D7 篡位回归");
  const found = findSealedOutbox(cid, { agentId });
  assert.equal(found?.seal?.contractId, cid, "TC 终局读面仍采信宿主自己的封条");
  assert.ok(found?.primaryPath?.endsWith("tc-report.md"));

  // 宿主下轮(同 cid 新会话):借道残件出视野,宿主新产物重封
  await backdate(join(tree, "dr-notes.md"));
  const hostRound2StartMs = Date.now() - 1000;
  await writeFile(join(outboxDir, "tc-final.md"), "# TC 终稿\n", "utf8");
  const r3 = await collectWorkerOutbox({
    agentId, outboxDir,
    files: ["dr-notes.md", "tc-report.md", "tc-final.md", "seal.json"],
    logger,
    boundContractId: cid,
    sessionKey: `agent:${agentId}:tc2`,
    sessionStartMs: hostRound2StartMs,
  });
  assert.deepEqual(r3.files, ["tc-final.md"], "宿主下轮收不到借道残件(鲜度过滤)");
  const seal3 = readOutboxSeal(tree);
  assert.equal(seal3?.contractId, cid);
  assert.equal(seal3?.sessionKey, `agent:${agentId}:tc2`);
  assert.deepEqual(seal3?.files, ["tc-final.md"]);
  assert.equal(existsSync(join(tree, "dr-notes.md")), true, "借道残件原地留树");
  assert.equal(existsSync(join(tree, "tc-report.md")), true, "宿主旧产物原地留树");
});

test("⑧D8 读端归属核对:contractId 错配封条 findSealedOutbox 一律跳过", async () => {
  const agentId = "b4seal-reader-agent";
  registerSandboxAgents([agentId]);
  const ws = wsFor(agentId);
  const cid = `TC-B4SEAL-READER-${Date.now()}`;
  await seedContract({ agentId, contractId: cid });
  const bind = await bindParticipantOutbox({ agentId, workspace: ws, contractId: cid, logger });
  assert.equal(bind.linked, true);
  const tree = resolvePhysicalWorkspacePath(bind.treeOutboxDir);

  // 篡位形态的封条:目录名对上(outbox-{cid}),载荷归属另一份合约
  await writeFile(join(tree, "ghost.md"), "usurper payload\n", "utf8");
  await writeFile(join(tree, "seal.json"), JSON.stringify({
    contractId: "TC-USURPER",
    sessionKey: "agent:usurper:1",
    collectedAt: Date.now(),
    primary: "ghost.md",
    files: ["ghost.md"],
    declaredStatus: "completed",
  }), "utf8");

  assert.equal(findSealedOutbox(cid, { agentId }), null, "hint 路径拒错配封条");
  assert.equal(findSealedOutbox(cid), null, "扫描路径拒错配封条");
});

test("⑨D8 树内鲜度过滤:旧 mtime 文件出采集出 seal,原地留树零隔离目录", async () => {
  const agentId = "b4seal-fresh-agent";
  registerSandboxAgents([agentId]);
  const ws = wsFor(agentId);
  const outboxDir = join(ws, "outbox");
  const cid = `TC-B4SEAL-FRESH-${Date.now()}`;
  await seedContract({ agentId, contractId: cid });
  const bind = await bindParticipantOutbox({ agentId, workspace: ws, contractId: cid, logger });
  assert.equal(bind.linked, true);
  const tree = resolvePhysicalWorkspacePath(bind.treeOutboxDir);

  await writeFile(join(outboxDir, "stale.md"), "上轮存量\n", "utf8");
  await backdate(join(tree, "stale.md"));
  const startMs = Date.now() - 1000;
  await writeFile(join(outboxDir, "fresh.md"), "本轮产物\n", "utf8");
  const result = await collectWorkerOutbox({
    agentId, outboxDir, files: ["stale.md", "fresh.md"], logger,
    boundContractId: cid, sessionKey: `agent:${agentId}:f1`,
    sessionStartMs: startMs,
  });
  assert.deepEqual(result.files, ["fresh.md"], "旧 mtime 文件出采集视野");
  const seal = readOutboxSeal(tree);
  assert.deepEqual(seal?.files, ["fresh.md"], "seal.files 随过滤结果");
  assert.equal(seal?.primary, "fresh.md");
  assert.equal(existsSync(join(tree, "stale.md")), true, "旧文件原地留树");
  assert.equal(existsSync(join(tree, ".stale")), false, "树内零 .stale 隔离目录(判定复活,搬运退役)");
});

test("⑩D8 seal 缺席树轮:收口逐级回退到观测 primaryPath(contract.output 缺席零短路)", async () => {
  const agentId = "b4seal-fallback-agent";
  registerSandboxAgents([agentId]);
  const ws = wsFor(agentId);
  const outboxDir = join(ws, "outbox");
  const cid = `TC-B4SEAL-FALLBACK-${Date.now()}`;
  const mirrorPath = join(ws, "mirror", `${cid}.md`); // 树模式零镜像 → 恒缺席
  const contract = await seedContract({ agentId, contractId: cid, output: mirrorPath });
  const bind = await bindParticipantOutbox({ agentId, workspace: ws, contractId: cid, logger });
  assert.equal(bind.linked, true);
  const tree = resolvePhysicalWorkspacePath(bind.treeOutboxDir);

  // 树内正本在场,封条缺席(封条写失败轮的形态)
  await writeFile(join(outboxDir, "delivered.md"), "# 树内正本\n交付内容\n", "utf8");
  assert.equal(readOutboxSeal(tree), null);
  assert.equal(existsSync(mirrorPath), false);

  const outcome = await resolveTerminalOutcome({
    trackingState: { contract },
    contractData: contract,
    executionObservation: { collected: true, primaryOutputPath: join(tree, "delivered.md") },
    logger,
  });
  assert.equal(outcome.terminalStatus, CONTRACT_STATUS.COMPLETED,
    "观测 primaryPath 在场即达标 — contract.output 缺席短路判 FAILED 即回归");
  assert.equal(
    resolvePhysicalWorkspacePath(outcome.terminalOutcome.artifact),
    join(tree, "delivered.md"),
    "交付凭据 = 本轮采集观测正本",
  );
});

test("⑥分类器拆分:裸标记交付双向达标,工具失败残渣照拦(2026-08-17 裁定锁)", async () => {
  const agentId = "seal-marker-agent";
  registerSandboxAgents([agentId]);

  // A. 声明 completed + 交付=裸控制标记(HARNESS_PROBE_OK 类探针的合规产物)→ 必须 COMPLETED
  const cidA = "TC-B4SEAL-MARKER-DECL";
  const contractA = await seedContract({ agentId, contractId: cidA });
  const wsA = wsFor(agentId);
  await mkdir(join(wsA, "outbox"), { recursive: true });
  const bindA = await bindParticipantOutbox({ agentId, workspace: wsA, contractId: cidA, logger });
  const treeA = bindA.treeOutboxDir || resolvePhysicalWorkspacePath(join(wsA, "outbox"));
  await writeFile(join(treeA, "harness_probe.md"), "HARNESS_PROBE_OK\n", "utf8");
  await writeFile(join(treeA, "runtime_result.json"), JSON.stringify({
    version: 1, status: "completed", summary: "probe done", primaryArtifactPath: "harness_probe.md",
  }), "utf8");
  const rA = await collectWorkerOutbox({
    agentId, outboxDir: join(wsA, "outbox"),
    files: ["harness_probe.md", "runtime_result.json"],
    logger, boundContractId: cidA, sessionKey: `agent:${agentId}:mk1`,
  });
  const outcomeA = await resolveTerminalOutcome({
    trackingState: { contract: contractA }, contractData: contractA,
    executionObservation: rA, logger,
  });
  assert.equal(
    outcomeA.terminalStatus, CONTRACT_STATUS.COMPLETED,
    "声明完结的裸标记交付被判 missing/failed = 2026-08-17 探针假失败回归",
  );

  // B. 无任何声明 + 交付=裸控制标记 → 同样达标(2026-08-17 拆分裁定:
  // 内容长相启发式撤出判定层,机械定义=存在+非空+非工具失败残渣)
  const cidB = "TC-B4SEAL-MARKER-BARE";
  const contractB = await seedContract({ agentId, contractId: cidB });
  const bindB = await bindParticipantOutbox({ agentId, workspace: wsA, contractId: cidB, logger });
  const treeB = bindB.treeOutboxDir || resolvePhysicalWorkspacePath(join(wsA, "outbox"));
  await writeFile(join(treeB, "note.md"), "MODEL_OK\n", "utf8");
  const rB = await collectWorkerOutbox({
    agentId, outboxDir: join(wsA, "outbox"),
    files: ["note.md"],
    logger, boundContractId: cidB, sessionKey: `agent:${agentId}:mk2`,
  });
  const outcomeB = await resolveTerminalOutcome({
    trackingState: { contract: contractB }, contractData: contractB,
    executionObservation: rB, logger,
  });
  assert.equal(
    outcomeB.terminalStatus, CONTRACT_STATUS.COMPLETED,
    "裸标记按长相被否 = 内容启发式越界回归(判定层无权替甲方审内容)",
  );

  // C. 交付=工具错误回声残渣 → 照拦(机械失败识别保留,不随启发式一起走)
  const cidC = "TC-B4SEAL-RESIDUE";
  const contractC = await seedContract({ agentId, contractId: cidC });
  const bindC = await bindParticipantOutbox({ agentId, workspace: wsA, contractId: cidC, logger });
  const treeC = bindC.treeOutboxDir || resolvePhysicalWorkspacePath(join(wsA, "outbox"));
  await writeFile(join(treeC, "result.md"), JSON.stringify({
    status: "error", tool: "write", file_path: "outbox/result.md",
  }), "utf8");
  const rC = await collectWorkerOutbox({
    agentId, outboxDir: join(wsA, "outbox"),
    files: ["result.md"],
    logger, boundContractId: cidC, sessionKey: `agent:${agentId}:mk3`,
  });
  const outcomeC = await resolveTerminalOutcome({
    trackingState: { contract: contractC }, contractData: contractC,
    executionObservation: rC, logger,
  });
  assert.equal(
    outcomeC.terminalStatus, CONTRACT_STATUS.FAILED,
    "工具错误回声冒充交付必须照拦 — 机械失败残渣识别失牙",
  );
});
