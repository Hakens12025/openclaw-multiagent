// lib/formal-runtime/suite-link-cases.js — 活链路 case 定义 + 纯逻辑（suite-link.js 的判定层）
//
// 这里只放无网络依赖的部分：case 归一化、期望评估、上游整包到达探测、阶段描述符。
// 驱动与观察原语在 suite-link.js；单测 tests/suite-link-units.test.js 直接覆盖本层。

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { evaluateOutputValidation } from "./test-output-validation.js";

const DEFAULT_SIMPLE_TIMEOUT_MS = 240000;
const DEFAULT_MULTI_HOP_TIMEOUT_MS = 600000;

// ── case 归一化 ───────────────────────────────────────────────────────────────
// 一个 case = { id, title, message, expectation:{ minBytes?, keywords?, multiHop? }, timeoutMs? }。
// 非法（缺 id/message、id 含空白）→ null。expectation 派生 requiresOutput / hasValidation。

export function normalizeLinkCase(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = typeof raw.id === "string" && raw.id.trim() && !/\s/.test(raw.id.trim()) ? raw.id.trim() : null;
  const message = typeof raw.message === "string" && raw.message.trim() ? raw.message.trim() : null;
  if (!id || !message) return null;

  const exp = raw.expectation && typeof raw.expectation === "object" ? raw.expectation : {};
  const minBytes = Number.isFinite(exp.minBytes) && exp.minBytes > 0 ? Math.trunc(exp.minBytes) : 0;
  const keywords = Object.freeze((Array.isArray(exp.keywords) ? exp.keywords : [])
    .filter((keyword) => typeof keyword === "string" && keyword.trim())
    .map((keyword) => keyword.trim()));
  const multiHop = exp.multiHop === true;
  const hasValidation = minBytes > 0 || keywords.length > 0;
  const timeoutMs = Number.isFinite(raw.timeoutMs) && raw.timeoutMs > 0
    ? Math.trunc(raw.timeoutMs)
    : (multiHop ? DEFAULT_MULTI_HOP_TIMEOUT_MS : DEFAULT_SIMPLE_TIMEOUT_MS);

  return Object.freeze({
    id,
    title: typeof raw.title === "string" && raw.title.trim() ? raw.title.trim() : id,
    message,
    timeoutMs,
    expectation: Object.freeze({
      minBytes,
      keywords,
      multiHop,
      hasValidation,
      requiresOutput: hasValidation || multiHop,
    }),
  });
}

// ── 期望评估（包 test-output-validation.js）─────────────────────────────────────

export function evaluateLinkExpectation({ content = "", expectation = {} } = {}) {
  const validation = evaluateOutputValidation({
    content,
    validate: { minBytes: expectation.minBytes || 0, keywords: [...(expectation.keywords || [])] },
    sizeFailureCode: "size_below_min",
    keywordFailureCode: "keywords_missing",
  });
  if (validation.ok) {
    return { ok: true, evidence: `output ${validation.size} bytes; minBytes=${expectation.minBytes || 0}; keywords matched=${(expectation.keywords || []).length}` };
  }
  if (validation.status === "size_below_min") {
    return { ok: false, evidence: `output ${validation.size} bytes < minBytes ${expectation.minBytes}` };
  }
  return { ok: false, evidence: `missing keywords: ${validation.missingKeywords.join(", ")}` };
}

// ── 上游整包下游到达探测（contract 作用域）──────────────────────────────────────
// E-CONTRACT-006 断言的是「上游整包到达了下游」，所以只认下游收包侧、且能锁定到本
// contract 的证据。producer 自己的树 outbox participants/<producer>/outbox-<cid>/
// 一律不认——它是产出正本，无论下游是否收到都存在，证明不了投递。
//
// 两个证据源（都是下游侧，都按 contractId 定界）：
//   1. agent_end 清理前的 inbox 快照 threads/{t}/runs/{r}/participants/<agentId>/inbox-<cid>/
//      （snapshotInboxToRunTree 写；目录名自带 cid → 天然定界，首选证据；
//        run 家由调用方经 contract-index 解析后以 participantsDir 传入）
//   2. 尚未清理的 live workspace inbox（仅当 inbox/contract.json 的 id == cid）
//      —— 覆盖「合约已终态但 agent_end 清理尚未落快照」的时间窗
//
// 判定：某 producer 算送达 = upstream/<producer>/ 至少一个文件，且当 contract.json
// 带 upstreamPackages 指针时该指针列出了这个 producer（指针缺失则只按目录判定）。
// 目录在、指针不认 → 记为 mismatch，不算证据（这是真实的一致性缺陷，值得单独报出）。

// 从 inbox/contract.json 读出定界用的 contractId 与 upstreamPackages 指针。
// 指针条目形如 "upstream/<producer>/"，取出 producer 名。
async function readInboxContractPointer(inboxDir) {
  try {
    const parsed = JSON.parse(await readFile(join(inboxDir, "contract.json"), "utf8"));
    const listed = Array.isArray(parsed?.upstreamPackages) ? parsed.upstreamPackages : [];
    // COMPAT(until v181): 指针条目是 { path, producer, files[], primary }。字符串形态
    // 只可能来自"改动落地前那一次 dispatch 写下的在飞合约"——upstreamPackages 全库唯一
    // 写入方是平台自己(runtime-mailbox.js),agent 从不写,所以窗口只有一轮。下个 tag 前删。
    // producer 优先取显式字段,取不到再从路径段还原:两种形态同一条规则,不留不对称。
    const producerOf = (item) => {
      const explicit = typeof item?.producer === "string" ? item.producer.trim() : "";
      if (explicit) return explicit;
      const path = typeof item === "string" ? item : (typeof item?.path === "string" ? item.path : "");
      const segments = path.replace(/^\/+|\/+$/g, "").split("/");
      return segments[0] === "upstream" && segments.length >= 2 ? segments[1] : "";
    };
    const producers = new Set(listed.map(producerOf).filter(Boolean));
    return {
      contractId: typeof parsed?.id === "string" ? parsed.id.trim() : null,
      pointerPresent: listed.length > 0,
      producers,
    };
  } catch {
    return { contractId: null, pointerPresent: false, producers: new Set() };
  }
}

// 扫一个 inbox 的 upstream/ 目录。requireContractId 非空时，contract.json 的 id
// 必须匹配才认（live inbox 的定界闸；快照路径已自带 cid，无需再闸）。
async function scanInboxUpstream({ inboxDir, label, requireContractId = null }) {
  const empty = { locations: [], mismatches: [] };
  // upstream/ 不存在时无论 contract.json 说什么都不构成证据——先 readdir,
  // 省掉多数目录上白读白解析一次 contract.json。
  let entries = [];
  try { entries = await readdir(join(inboxDir, "upstream"), { withFileTypes: true }); } catch { return empty; }

  const pointer = await readInboxContractPointer(inboxDir);
  if (requireContractId && pointer.contractId !== requireContractId) return empty;

  const locations = [];
  const mismatches = [];
  for (const entry of entries) {
    // 目录与目录级链都算包目录：链接优先物化后 live inbox 的 upstream/<producer>
    // 是指向产者树 outbox 的链（readdir withFileTypes 不穿链，链条目单判），
    // 下一行的 readdir 会穿链列出树内文件；链指向非目录时 readdir 抛错即跳过。
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    let files = [];
    try { files = await readdir(join(inboxDir, "upstream", entry.name)); } catch { continue; }
    if (files.length === 0) continue;
    if (pointer.pointerPresent && !pointer.producers.has(entry.name)) {
      mismatches.push(`${label}/upstream/${entry.name}/ (${files.length} files) is absent from the upstreamPackages pointer`);
      continue;
    }
    const pointerNote = pointer.pointerPresent ? "pointer lists it" : "pointer absent";
    locations.push(`${label}/upstream/${entry.name}/ (${files.length} files, ${pointerNote})`);
  }
  return { locations, mismatches };
}

export async function probeUpstreamPackages({ contractId = null, participantsDir = null, inboxRoots = [] } = {}) {
  const cid = typeof contractId === "string" ? contractId.trim() : "";
  const locations = [];
  const mismatches = [];

  // 树内快照：participants/<agent>/inbox-<cid>/（目录名嵌 cid，无 cid 无从定位）
  if (participantsDir && cid) {
    let agents = [];
    try { agents = await readdir(participantsDir, { withFileTypes: true }); } catch { agents = []; }
    for (const agent of agents) {
      if (!agent.isDirectory()) continue;
      const scan = await scanInboxUpstream({
        inboxDir: join(participantsDir, agent.name, `inbox-${cid}`),
        label: `tree:${agent.name}:inbox-${cid}`,
      });
      locations.push(...scan.locations);
      mismatches.push(...scan.mismatches);
    }
  }

  // live inbox 只在能按 cid 定界时才看；没有 cid 就不看（旧探测正是缺了这道闸，
  // 让上一个 contract 的残留包也能让检查通过）。
  if (cid) {
    for (const root of Array.isArray(inboxRoots) ? inboxRoots : []) {
      if (!root?.inboxDir) continue;
      const scan = await scanInboxUpstream({
        inboxDir: root.inboxDir,
        label: `live:${root.agentId || "?"}:inbox`,
        requireContractId: cid,
      });
      locations.push(...scan.locations);
      mismatches.push(...scan.mismatches);
    }
  }

  return { found: locations.length > 0, locations, mismatches };
}

// ── 阶段描述符（按 expectation 裁剪；也是 blocked 级联的依据）────────────────────

export function buildLinkStageDescriptors(testCase) {
  const cid = testCase.id;
  const stages = [
    { key: "inject", id: `single.${cid}.inject`, subsystem: "single", title: `${cid}: test inject accepted`, code: "E-DISPATCH-001" },
    { key: "created", id: `contract.${cid}.created`, subsystem: "contract", title: `${cid}: contract created after ingress`, code: "E-CONTRACT-001" },
    { key: "terminal", id: `contract.${cid}.terminal-completed`, subsystem: "contract", title: `${cid}: contract reached terminal completed`, code: "E-CONTRACT-002" },
  ];
  if (testCase.expectation.requiresOutput) {
    stages.push({ key: "mirrored", id: `contract.${cid}.output-mirrored`, subsystem: "contract", title: `${cid}: output mirrored on shared contract`, code: "E-CONTRACT-004" });
  }
  if (testCase.expectation.hasValidation) {
    stages.push({ key: "validated", id: `contract.${cid}.output-validated`, subsystem: "contract", title: `${cid}: output meets minBytes/keywords expectation`, code: "E-CONTRACT-007" });
  }
  if (testCase.expectation.multiHop) {
    stages.push({ key: "upstream", id: `contract.${cid}.upstream-package`, subsystem: "contract", title: `${cid}: upstream package flowed downstream`, code: "E-CONTRACT-006" });
  }
  return stages;
}

// ── 内联 case 定义 ────────────────────────────────────────────────────────────

export const DISPATCH_LINK_CASES = Object.freeze([
  normalizeLinkCase({
    id: "answer-direct",
    title: "direct question answered through the conveyor",
    message: "请直接回答：17 加 25 等于多少？用一句话回答即可。",
    expectation: {},
    timeoutMs: 240000,
  }),
  normalizeLinkCase({
    id: "small-file-task",
    title: "small task produces a deliverable file",
    message: "请生成一份简短的 markdown 笔记，列出 5 条软件测试的基本原则，每条一句话。",
    expectation: { minBytes: 120 },
    timeoutMs: 300000,
  }),
]);

export const PIPELINE_LINK_CASES = Object.freeze([
  normalizeLinkCase({
    id: "brief-to-deliverable",
    title: "multi-hop: planner brief flows to executor deliverable",
    message: "请规划并产出一份《系统健康巡检清单》markdown 文档：先给出大纲简报，再产出完整清单，至少 10 条检查项，每条附一句检查方法。",
    expectation: { minBytes: 400, multiHop: true },
    timeoutMs: 600000,
  }),
  normalizeLinkCase({
    id: "research-summary",
    title: "multi-hop: research brief becomes a structured summary",
    message: "请先拟一份研究简报，再产出《本地缓存策略对比》markdown 总结：覆盖 LRU、LFU、FIFO 三种策略的优缺点与适用场景。",
    expectation: { minBytes: 400, keywords: ["LRU", "LFU", "FIFO"], multiHop: true },
    timeoutMs: 600000,
  }),
]);
