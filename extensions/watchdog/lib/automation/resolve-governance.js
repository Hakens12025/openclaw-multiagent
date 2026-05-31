/**
 * resolve-governance.js — governance 的唯一合流点（修死链 c）
 *
 * 普查结论：governance 在 deriveDecision / computeImprovementState 等处分散读 spec.governance，
 * 且 runtime.governanceSnapshot 写了 0 处读 → 死对象。
 *
 * resolveGovernance 是 governance 的「单一读法」：
 *   优先级：runtime.governanceSnapshot（经合法性校验）覆盖 spec.governance 对应字段，否则用 spec。
 *   纯函数；无 IO；不改 spec、不改 runtime（只读合并产出一个新对象）。
 *
 * 「用得越多越顺」变物理的关键：所有 governance 读点改经此函数后，
 * ProfileLifecycle 写的 governanceSnapshot 才真正被 deriveDecision 消费（非死对象）。
 *
 * 安全阀：runtime.governanceSnapshotDisabled === true → 全局忽略 snapshot，回 spec 默认（熔断）。
 */

import {
  normalizeFiniteNumber,
  normalizePositiveInteger,
  normalizeRecord,
  normalizeString,
} from "../core/normalize.js";

// snapshot 可覆盖的硬化字段白名单 —— ProfileLifecycle 只允许「收紧/调节」这些，
// 绝不允许 snapshot 引入 spec 之外的新治理维度（防止第二真值）。
const SNAPSHOT_OVERRIDABLE_FIELDS = Object.freeze(["mode", "maxRounds", "earlyStopPatience", "minImprovement"]);

const VALID_GOVERNANCE_MODES = new Set([
  "continuous",
  "once",
  "oneshot",
  "one_shot",
  "single",
]);

// spec.governance 读出基线（与 automation-registry.normalizeGovernance 的字段一致，
// 此处只取 deriveDecision/computeImprovementState 真实消费的子集 + mode，避免重建整张表）。
function readSpecGovernance(spec) {
  const governance = normalizeRecord(spec?.governance, {});
  return {
    mode: normalizeString(governance.mode)?.toLowerCase() || "continuous",
    maxRounds: normalizePositiveInteger(governance.maxRounds, 0),
    earlyStopPatience: normalizePositiveInteger(governance.earlyStopPatience, 0),
    minImprovement: normalizeFiniteNumber(governance.minImprovement, 0) || 0,
  };
}

// 校验单个 snapshot 覆盖值；非法（类型/越界/未知 enum）→ 返回 undefined（调用方回退 spec）。
function validateOverride(field, value) {
  if (value == null) return undefined;
  switch (field) {
    case "mode": {
      const mode = normalizeString(value)?.toLowerCase();
      return mode && VALID_GOVERNANCE_MODES.has(mode) ? mode : undefined;
    }
    case "maxRounds":
    case "earlyStopPatience": {
      // 必须是有限非负整数；负数/NaN/字符串 → 非法
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
      return Math.floor(value);
    }
    case "minImprovement": {
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
      return value;
    }
    default:
      return undefined;
  }
}

/**
 * resolveGovernance(spec, runtime) → 合并后的治理参数（唯一读法）。
 * 纯函数：不改 spec、不改 runtime。
 */
export function resolveGovernance(spec, runtime) {
  const base = readSpecGovernance(spec);

  // 安全阀：熔断开 → 全局忽略 snapshot，回 spec。
  if (runtime?.governanceSnapshotDisabled === true) {
    return base;
  }

  const snapshot = normalizeRecord(runtime?.governanceSnapshot, null);
  if (!snapshot) return base;

  const resolved = { ...base };
  for (const field of SNAPSHOT_OVERRIDABLE_FIELDS) {
    const override = validateOverride(field, snapshot[field]);
    if (override !== undefined) {
      resolved[field] = override;
    }
  }
  return resolved;
}

/**
 * 校验并归一一个候选 governanceSnapshot（ProfileLifecycle 写入 runtime 前调用）。
 * 只保留白名单内的合法字段；返回 null 表示「无有效覆盖」（不存空壳）。
 */
export function normalizeGovernanceSnapshot(value) {
  const source = normalizeRecord(value, null);
  if (!source) return null;

  const out = {};
  for (const field of SNAPSHOT_OVERRIDABLE_FIELDS) {
    const override = validateOverride(field, source[field]);
    if (override !== undefined) {
      out[field] = override;
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}
