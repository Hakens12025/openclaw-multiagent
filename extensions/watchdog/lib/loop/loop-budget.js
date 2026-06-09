// Single source of truth for loop structural caps. Any other module that needs
// a fallback (e.g. session normalization) imports these — never re-literal them.
export const DEFAULT_LOOP_MAX_ROUNDS = 3;
export const DEFAULT_LOOP_MAX_EXPERIMENTS = 30;

export function normalizePositiveInteger(value, fallback = null) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    return Math.trunc(numeric);
  }
  return fallback;
}

export function normalizeLoopBudget(budget, { currentRound = 1 } = {}) {
  const source = budget && typeof budget === "object" ? budget : {};
  const normalizedCurrentRound = normalizePositiveInteger(currentRound, 1) || 1;
  return {
    maxRounds: normalizePositiveInteger(source.maxRounds, DEFAULT_LOOP_MAX_ROUNDS),
    maxExperiments: normalizePositiveInteger(source.maxExperiments, DEFAULT_LOOP_MAX_EXPERIMENTS),
    usedRounds: normalizePositiveInteger(source.usedRounds, normalizedCurrentRound) || normalizedCurrentRound,
    usedExperiments: normalizePositiveInteger(source.usedExperiments, 0) || 0,
  };
}

export function resolveLoopStartBudget(config, { currentRound = 1, loopSpec = null } = {}) {
  const source = config && typeof config === "object" ? config : {};
  const budget = source.budget && typeof source.budget === "object" ? source.budget : {};
  // Precedence (later wins): DEFAULT < LoopSpec-declared cap < runtime budget < explicit runtime config.
  // The loop literally carries its own limit (环自带 limit); when undeclared it falls through to DEFAULT.
  const specMaxRounds = normalizePositiveInteger(loopSpec?.maxRounds, null);
  const specMaxExperiments = normalizePositiveInteger(loopSpec?.maxExperiments, null);
  return normalizeLoopBudget({
    ...(specMaxRounds ? { maxRounds: specMaxRounds } : {}),
    ...(specMaxExperiments ? { maxExperiments: specMaxExperiments } : {}),
    ...budget,
    ...(source.maxRounds !== undefined ? { maxRounds: source.maxRounds } : {}),
    ...(source.maxExperiments !== undefined ? { maxExperiments: source.maxExperiments } : {}),
  }, {
    currentRound,
  });
}

// 回显「解析后的有效预算 + 来源」:让 compose 调用方/operator 看见真实上限(而非依赖看不见的多层兜底)。
// normMaxRounds/normMaxExperiments 是入口已归一的值(null=未声明)。source=declared|default。
// 不把默认值存进 spec —— resolvedBudget 仅供展示,保 single-source fall-through。
export function buildLoopBudgetEcho(loopSpec, { normMaxRounds = null, normMaxExperiments = null } = {}) {
  return {
    resolvedBudget: resolveLoopStartBudget({}, { loopSpec }),
    budgetSource: {
      maxRounds: normMaxRounds != null ? "declared" : "default",
      maxExperiments: normMaxExperiments != null ? "declared" : "default",
    },
  };
}
