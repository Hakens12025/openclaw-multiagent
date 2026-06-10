// lib/formal-runtime/suite-link-cases.js — 活链路 case 定义 + 纯逻辑（suite-link.js 的判定层）
//
// 这里只放无网络依赖的部分：case 归一化、期望评估、上游整包双布局探测、阶段描述符。
// 驱动与观察原语在 suite-link.js；单测 tests/suite-link-units.test.js 直接覆盖本层。

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { evaluateOutputValidation } from "../test-output-validation.js";

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

// ── 上游整包双布局探测 ─────────────────────────────────────────────────────────
// 已核实两种真实布局并存（recon + 现场样本 control-plane/artifacts/TC-1780184090847）：
//   A. artifacts/<cid>/<producer>/(manifest.json + files)（artifact-store.js 现行）
//   B. artifacts/<cid>/ 直接放文件（旧 loop 流转样本）
//   C. <ws>/inbox/upstream/<producer>/（下游收包侧，copyUpstreamArtifactsToInbox）
// 任一处有内容即 found；都没有才算失败（E-CONTRACT-006）。

export async function probeUpstreamPackages({ artifactsContractDir = null, inboxRoots = [] } = {}) {
  const locations = [];
  if (artifactsContractDir) {
    try {
      const entries = await readdir(artifactsContractDir, { withFileTypes: true });
      const looseFiles = entries.filter((entry) => entry.isFile()).length;
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        let files = [];
        try { files = await readdir(join(artifactsContractDir, entry.name)); } catch { continue; }
        if (files.length === 0) continue;
        const manifestNote = files.includes("manifest.json") ? "manifest" : "no-manifest";
        locations.push(`artifacts/<cid>/${entry.name}/ (${files.length} files, ${manifestNote})`);
      }
      if (looseFiles > 0) locations.push(`artifacts/<cid>/ flat (${looseFiles} files)`);
    } catch {}
  }
  for (const root of Array.isArray(inboxRoots) ? inboxRoots : []) {
    if (!root?.inboxDir) continue;
    const upstreamDir = join(root.inboxDir, "upstream");
    try {
      const producers = await readdir(upstreamDir, { withFileTypes: true });
      for (const producer of producers) {
        if (!producer.isDirectory()) continue;
        let files = [];
        try { files = await readdir(join(upstreamDir, producer.name)); } catch { continue; }
        if (files.length > 0) {
          locations.push(`${root.agentId || "?"}:inbox/upstream/${producer.name}/ (${files.length} files)`);
        }
      }
    } catch {}
  }
  return { found: locations.length > 0, locations };
}

// ── 阶段描述符（按 expectation 裁剪；也是 blocked 级联的依据）────────────────────

export function buildLinkStageDescriptors(testCase) {
  const cid = testCase.id;
  const stages = [
    { key: "inject", id: `dispatch.${cid}.inject`, subsystem: "dispatch", title: `${cid}: test inject accepted`, code: "E-DISPATCH-001" },
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
