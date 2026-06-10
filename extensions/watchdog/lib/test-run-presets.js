// lib/test-run-presets.js — preset 解析与 case 收集（CheckResult 体系）
//
// case 真值内联在各 suite 模块里（不再有独立 case catalog）：
//   dispatch/pipeline → lib/formal-runtime/suite-link.js（DISPATCH/PIPELINE_LINK_CASES）
//   system-action     → lib/formal-runtime/checks/system-action-chain.js（SYSTEM_ACTION_CASES，
//                       suite 驱动整组执行，不支持 per-case 子集）
//   health/loop/operator/knowledge → 自寻靶，无 case 概念
// 因此 --case 只对 dispatch/pipeline 的 case id 生效。

import { listFormalTestPresets } from "./formal-test-presets.js";
import { DISPATCH_LINK_CASES, PIPELINE_LINK_CASES } from "./formal-runtime/suite-link.js";

export const DEV_TEST_PRESETS = listFormalTestPresets();
export const TEST_RUN_CLEAN_MODE = "session-clean";
const TEST_RUN_CLEAN_MODES = new Set([TEST_RUN_CLEAN_MODE, "none"]);

const PRESET_MAP = new Map(DEV_TEST_PRESETS.map((preset) => [preset.id, preset]));

function collectCases(caseIds, cases, suite) {
  const caseMap = new Map(cases.map((item) => [item.id, item]));
  return caseIds.map((id) => {
    const entry = caseMap.get(id);
    if (!entry) {
      throw new Error(`unknown ${suite} case: ${id}`);
    }
    return entry;
  });
}

export function collectDispatchCases(caseIds) {
  return collectCases(caseIds, DISPATCH_LINK_CASES, "dispatch");
}

export function collectPipelineCases(caseIds) {
  return collectCases(caseIds, PIPELINE_LINK_CASES, "pipeline");
}

export function normalizeTestRunCleanMode(value) {
  const normalized = String(value || "").trim() || TEST_RUN_CLEAN_MODE;
  if (!TEST_RUN_CLEAN_MODES.has(normalized)) {
    throw new Error(`unsupported test run cleanMode: ${normalized}`);
  }
  return normalized;
}

// cleanMode 单一真值 = preset 声明；请求值只做合法性校验（dashboard 历史上恒发
// session-clean，不能让它把只读 suite——health/operator/knowledge——推进 fullReset）。
export function resolveRunCleanMode(preset, requested) {
  normalizeTestRunCleanMode(requested);
  return normalizeTestRunCleanMode(preset?.cleanMode);
}

function buildAdHocCasePreset({
  suite,
  caseId,
  caseDef,
  transport = "isolated",
} = {}) {
  const normalizedCaseId = String(caseId || "").trim();
  if (!normalizedCaseId) {
    throw new TypeError("buildAdHocCasePreset requires caseId");
  }
  const description = String(caseDef?.description || caseDef?.message || normalizedCaseId).trim();
  return {
    id: `case-${normalizedCaseId}`,
    label: `单用例 ${normalizedCaseId}`,
    description,
    suite,
    caseIds: [normalizedCaseId],
    resetBetweenCases: false,
    transport,
    cleanMode: TEST_RUN_CLEAN_MODE,
    requestedCaseId: normalizedCaseId,
  };
}

function resolveAdHocCasePreset(caseId) {
  const normalizedCaseId = String(caseId || "").trim();
  if (!normalizedCaseId) return null;

  const candidates = [
    { suite: "dispatch", transport: "isolated", collect: collectDispatchCases },
    { suite: "pipeline", transport: "isolated", collect: collectPipelineCases },
  ];
  for (const candidate of candidates) {
    try {
      const caseDef = candidate.collect([normalizedCaseId])[0];
      if (!caseDef) continue;
      return buildAdHocCasePreset({
        suite: candidate.suite,
        caseId: normalizedCaseId,
        caseDef,
        transport: candidate.transport,
      });
    } catch {
      continue;
    }
  }

  return null;
}

export function resolveRequestedFormalPreset({
  presetId = null,
  caseId = null,
} = {}) {
  const normalizedPresetId = String(presetId || "").trim();
  const normalizedCaseId = String(caseId || "").trim();

  if (normalizedPresetId && normalizedCaseId) {
    throw new Error("provide either presetId or caseId, not both");
  }

  if (normalizedPresetId) {
    const preset = PRESET_MAP.get(normalizedPresetId);
    if (!preset) {
      throw new Error(`unknown preset: ${normalizedPresetId}`);
    }
    return {
      ...preset,
      caseIds: [...preset.caseIds],
    };
  }

  if (normalizedCaseId) {
    const preset = resolveAdHocCasePreset(normalizedCaseId);
    if (!preset) {
      throw new Error(`unknown case: ${normalizedCaseId} (per-case runs support dispatch/pipeline case ids only)`);
    }
    return preset;
  }

  throw new Error("missing presetId or caseId");
}
