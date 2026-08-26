// lib/contract/contract-lineage.js — 谱系(threadId/runId)铸造与继承(备忘录142 §三/§五批①/§九)。
// 批①纪律:纯字段新增,只写不读 —— 本模块只铸造/归一/透传谱系,任何行为判定不得消费它(读者是批②)。
// 命名裁定(§九):身份=整串(hash 部分即身份),runId 里的 ts 只做展示排序,永不作排序键。

import { createHash, randomBytes } from "node:crypto";
import { normalizeRecord, normalizeString } from "../core/normalize.js";

// threadId:业务任务线身份(≠ 运行时 session)。有稳定会话种子(conversationId/
// schedule id/automation id)则确定性派生 —— 同线永远同 id,续接触发天然归队;
// 无种子(webui/a2a/test-inject 现状)则随机新线。
export function mintThreadId(seedIdentity = null) {
  const seed = normalizeString(seedIdentity);
  const hash8 = seed
    ? createHash("sha256").update(seed, "utf8").digest("hex").slice(0, 8)
    : randomBytes(4).toString("hex");
  return `t-${hash8}`;
}

// runId:一次入口触发 → 派生合约链全部终态(§三:run 边界靠谱系传染,不靠时间窗)。
export function mintRunId(now = Date.now()) {
  const ts = Number.isFinite(now) ? Number(now) : Date.now();
  return `r-${ts}-${randomBytes(3).toString("hex")}`;
}

// 防御式归一(供建约工厂):非法/空载 → null,合法载荷缺失位补 null,不 fabricate。
export function normalizeLineage(raw) {
  const value = normalizeRecord(raw, null);
  if (!value) return null;
  const threadId = normalizeString(value.threadId);
  const runId = normalizeString(value.runId);
  if (!threadId && !runId) return null;
  return {
    threadId: threadId || null,
    runId: runId || null,
  };
}

export function buildLineage({ threadId = null, runId = null } = {}) {
  return normalizeLineage({ threadId, runId });
}

// 派生点继承:子约/回投信封抄源约谱系。源约无谱系 → null(过渡期旧约无谱系是合法态)。
export function inheritLineage(sourceContract) {
  return normalizeLineage(sourceContract?.lineage);
}

// 批② 工厂兜底:树需要全覆盖,每约必有家 —— 建约时刻谱系缺位/不全,由【工厂】铸
// 孤儿线补全(与批①"继承不造假"不冲突:兜底发生在工厂,不发生在继承点)。
// 缺 threadId → 随机新线;缺 runId → 铸新 run;两位齐全原样返回。
export function ensureLineage(raw, { now = Date.now() } = {}) {
  const normalized = normalizeLineage(raw);
  if (normalized?.threadId && normalized?.runId) return normalized;
  return {
    threadId: normalized?.threadId || mintThreadId(),
    runId: normalized?.runId || mintRunId(now),
  };
}

// tracker 回填:合约带谱系 → 覆盖 createTrackingState 的随机 runId 并落 threadId;
// 无谱系约保持随机 runId(=现状)。纯状态写入,不做任何行为分支 —— 既有执行代号键(session-epoch-key)
// 消费者读到的仍是 trackingState.runId 这同一个位置。
// 只落 threadId(全库零读者的新字段)。【绝不触碰 trackingState.runId】——那是
// tracker 实例代号,是 execution epoch key 的既有原料("every run gets its own
// runId" 防轮次毒化的不变量;该 helper 2026-08-18 已搬至
// lib/runtime/session-epoch-key.js,同批带走了本条记录的副本);谱系 runId 与它
// 同名异物,合并会让全程同 epoch、硬停标记跨轮逃逸(2026-08-14 批①对抗审查抓获)。谱系 runId 的读者(批② recorder)
// 从 trackingState.contract.lineage 取——toTrackingContract 白名单已镜像。
export function applyContractLineageToTracking(trackingState, contract) {
  if (!trackingState || typeof trackingState !== "object") return null;
  const lineage = inheritLineage(contract);
  if (!lineage) return null;
  if (lineage.threadId) trackingState.threadId = lineage.threadId;
  return lineage;
}
