// contract-expectations.js — contract 结构化三部曲的第三块(spec §4)。
// expectations 是审计判据不是运行时指令:平台专写(建约抄参数/每跳重导出),
// 执行者永不可触;考官(P6)按它与会话 trace 做 diff。受理时刻做结构校验——
// 垃圾期望结构化拒绝,不修补不猜。

import { isAbsolute, join } from "node:path";
import { normalizeRecord, normalizeString } from "../core/normalize.js";
import { isKnownIntentType } from "../protocol/protocol-primitives.js";
import { listExposedToolIntents } from "../system-action/collaboration-intent-policy.js";

function normalizeRequiredArtifact(entry, index) {
  const asString = normalizeString(entry);
  if (asString) {
    return { value: { path: asString, required: true } };
  }
  const record = normalizeRecord(entry, null);
  const path = normalizeString(record?.path);
  if (path) {
    // required 透传:optional 产物缺席只 waived 不亮红(考官侧已有对应分支)。
    return { value: { path, required: record.required !== false } };
  }
  return { error: `requiredArtifacts[${index}] needs a non-empty path` };
}

function normalizeExpectedAction(entry, index) {
  const record = normalizeRecord(entry, null);
  if (!record) {
    return { error: `expectedActions[${index}] must be an object` };
  }
  const intent = normalizeString(record.intent);
  if (!intent) {
    return { error: `expectedActions[${index}] needs an intent` };
  }
  if (!isKnownIntentType(intent)) {
    return { error: `expectedActions[${index}] has unknown intent: ${intent}` };
  }
  // 可声明词汇收敛到授权单源表的工具暴露面(spec §5 一表四消费之③):
  // create_task 这类编排 intent 有词汇位但 assignee 无法经工具面自行发起,
  // 声明它们只会让考官必判 violated,受理时刻直接拒绝。
  if (!listExposedToolIntents().includes(intent)) {
    return { error: `expectedActions[${index}] intent is outside the declarable collaboration surface: ${intent}` };
  }
  return {
    value: {
      intent,
      target: normalizeString(record.target) || null,
      required: record.required !== false,
    },
  };
}

// → { ok:true, expectations: {requiredArtifacts, expectedActions} | null }
//   | { ok:false, error }
// 缺席与空壳都归 null:没有期望就没有可核验对象,考官只做产物兜底。
export function normalizeContractExpectations(raw) {
  if (raw === null || raw === undefined) {
    return { ok: true, expectations: null };
  }
  if (!normalizeRecord(raw, null)) {
    return { ok: false, error: "expectations must be an object" };
  }

  const requiredArtifacts = [];
  if (raw.requiredArtifacts !== undefined) {
    if (!Array.isArray(raw.requiredArtifacts)) {
      return { ok: false, error: "requiredArtifacts must be an array" };
    }
    for (const [index, entry] of raw.requiredArtifacts.entries()) {
      const normalized = normalizeRequiredArtifact(entry, index);
      if (normalized.error) return { ok: false, error: normalized.error };
      requiredArtifacts.push(normalized.value);
    }
  }

  const expectedActions = [];
  if (raw.expectedActions !== undefined) {
    if (!Array.isArray(raw.expectedActions)) {
      return { ok: false, error: "expectedActions must be an array" };
    }
    for (const [index, entry] of raw.expectedActions.entries()) {
      const normalized = normalizeExpectedAction(entry, index);
      if (normalized.error) return { ok: false, error: normalized.error };
      expectedActions.push(normalized.value);
    }
  }

  if (requiredArtifacts.length === 0 && expectedActions.length === 0) {
    return { ok: true, expectations: null };
  }
  return { ok: true, expectations: { requiredArtifacts, expectedActions } };
}

// 供给侧物化(2026-08-12 期望断供修复):期望路径在建约抄写时钉成绝对路径——
// 相对路径按受托方 workspace 解析。判决侧(expectation-check)保持纯机械 stat,
// 不做任何"相对于谁"的猜测;~ 前缀交由判决侧既有展开。
export function materializeExpectationPaths(expectations, workspaceRoot) {
  if (!expectations?.requiredArtifacts?.length || !workspaceRoot) {
    return expectations;
  }
  return {
    ...expectations,
    requiredArtifacts: expectations.requiredArtifacts.map((entry) => (
      entry?.path && typeof entry.path === "string"
        && !isAbsolute(entry.path) && !entry.path.startsWith("~")
        ? { ...entry, path: join(workspaceRoot, entry.path) }
        : entry
    )),
  };
}

// 固定管线每跳重导出挂点(spec 决议 20):图/规格今天没有期望定义 → 每跳
// 期望为空,考官只做产物兜底,不判 violated。图 schema 增补期望字段时,
// 在此按 (graph, assignee) 导出,建约方原样落约。
export function buildHopExpectations() {
  return null;
}
