/**
 * HarnessModule 生命周期对象的正式字段契约（形式化 schema）。
 *
 * 此文件是 HarnessModule 链路 5+1 对象的**单一权威字段定义**（备忘录115 §3.1 + P0 归一）：
 *   - HarnessModuleDefinition   模块定义（id/kind/hardShaped）
 *   - HarnessModuleConfig       模块配置（automationSpec.harness.moduleConfig[moduleId]）
 *   - HarnessModuleStartInput   start 阶段入参（contract.js buildHarnessModuleStartInput 产出）
 *   - HarnessModuleFinalizeInput finalize 阶段入参（buildHarnessModuleFinalizeInput 产出）
 *   - HarnessModuleResult       单模块结果（normalizeHarnessModuleRun 产出的 moduleRun）
 *   - HarnessRun                run 级聚合（唯一 run 级事实源）
 *
 * 4 kind 集合（guard/collector/gate/normalizer）在此定义，全仓引用此处，不重建。
 * 不依赖 catalog/run（避免循环引用）。不改运行时行为，只做形式化校验。
 *
 * 契约原则：**只锁已在用的最小字段**，不加没人用的字段。validate 只校验形状，
 * 拒非法，不重塑数据。
 */

import {
  KNOWN_HARNESS_FAILURE_CLASSES,
  HARNESS_EVIDENCE_KEY,
} from "./harness-evidence-vocab.js";

// ── 4 kind 单一权威集合（全仓 source of truth）────────────────────────────────
export const HARNESS_MODULE_KIND = Object.freeze({
  GUARD: "guard",
  COLLECTOR: "collector",
  GATE: "gate",
  NORMALIZER: "normalizer",
});

export const VALID_HARNESS_MODULE_KINDS = Object.freeze([
  HARNESS_MODULE_KIND.GUARD,
  HARNESS_MODULE_KIND.COLLECTOR,
  HARNESS_MODULE_KIND.GATE,
  HARNESS_MODULE_KIND.NORMALIZER,
]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function checkKind(rawKind, problems, { required = true } = {}) {
  const kind = typeof rawKind === "string" ? rawKind.toLowerCase() : rawKind;
  if (!kind) {
    if (required) problems.push("required field \"kind\" is missing");
    return;
  }
  if (!VALID_HARNESS_MODULE_KINDS.includes(kind)) {
    problems.push(`"kind" must be one of [${VALID_HARNESS_MODULE_KINDS.join(", ")}], got "${rawKind}"`);
  }
}

// ── HarnessModuleDefinition ───────────────────────────────────────────────────
/**
 * 必填: id(以 "harness:" 开头) / kind(4 类之一)。可选: hardShaped(string[])。
 * @param {unknown} def
 * @returns {{ ok: boolean, problems: string[] }}
 */
export function validateHarnessModuleDefinition(def) {
  const problems = [];

  if (!isPlainObject(def)) {
    return { ok: false, problems: ["definition must be a plain object"] };
  }

  const id = def.id || def.moduleId;
  if (!id || typeof id !== "string") {
    problems.push("required field \"id\" is missing or not a string");
  } else if (!id.startsWith("harness:")) {
    problems.push(`"id" must start with "harness:", got "${id}"`);
  }

  checkKind(def.kind, problems, { required: true });

  if (def.hardShaped !== undefined) {
    if (!Array.isArray(def.hardShaped)) {
      problems.push("optional field \"hardShaped\" must be an array when present");
    } else {
      const nonStrings = def.hardShaped.filter((item) => typeof item !== "string");
      if (nonStrings.length > 0) {
        problems.push(`"hardShaped" must be an array of strings; found ${nonStrings.length} non-string item(s)`);
      }
    }
  }

  return { ok: problems.length === 0, problems };
}

// ── HarnessModuleConfig ───────────────────────────────────────────────────────
/**
 * 模块配置：automationSpec.harness.moduleConfig[moduleId] 经 normalizeRecord 后的 record。
 * 最小契约：必须是 plain object（缺省 {}）；无强制必填键——配置键随模块而异
 * （allowedTools/allowedWorkspaceRoots/maxRetry/budgetSeconds/timeoutSeconds 等
 * 由各 guard 按需读，见 harness-module-evaluators.js buildGuardContext）。
 * @param {unknown} config
 * @returns {{ ok: boolean, problems: string[] }}
 */
export function validateHarnessModuleConfig(config) {
  const problems = [];
  if (!isPlainObject(config)) {
    problems.push("config must be a plain object");
  }
  return { ok: problems.length === 0, problems };
}

// ── HarnessModuleStartInput ───────────────────────────────────────────────────
/**
 * start 阶段入参（buildHarnessModuleStartInput 产出）。
 * 必填: phase==="start" / module(合规 HarnessModuleDefinition)。
 * 可选(已在用): run / automationSpec / executionContext / moduleConfig。
 * @param {unknown} input
 * @returns {{ ok: boolean, problems: string[] }}
 */
export function validateHarnessModuleStartInput(input) {
  const problems = [];
  if (!isPlainObject(input)) {
    return { ok: false, problems: ["start input must be a plain object"] };
  }
  if (input.phase !== "start") {
    problems.push(`"phase" must be "start", got "${input.phase}"`);
  }
  const moduleCheck = validateHarnessModuleDefinition(input.module);
  if (!moduleCheck.ok) {
    problems.push(`"module" invalid: ${moduleCheck.problems.join("; ")}`);
  }
  if (input.moduleConfig !== undefined && !isPlainObject(input.moduleConfig)) {
    problems.push("optional field \"moduleConfig\" must be a plain object when present");
  }
  return { ok: problems.length === 0, problems };
}

// ── HarnessModuleFinalizeInput ────────────────────────────────────────────────
/**
 * finalize 阶段入参（buildHarnessModuleFinalizeInput 产出 = start 入参 + 终态证据）。
 * 必填: phase==="finalize" / module(合规)。可选(已在用): terminalSource / baseEvidence。
 * @param {unknown} input
 * @returns {{ ok: boolean, problems: string[] }}
 */
export function validateHarnessModuleFinalizeInput(input) {
  const problems = [];
  if (!isPlainObject(input)) {
    return { ok: false, problems: ["finalize input must be a plain object"] };
  }
  if (input.phase !== "finalize") {
    problems.push(`"phase" must be "finalize", got "${input.phase}"`);
  }
  const moduleCheck = validateHarnessModuleDefinition(input.module);
  if (!moduleCheck.ok) {
    problems.push(`"module" invalid: ${moduleCheck.problems.join("; ")}`);
  }
  if (input.terminalSource !== undefined && !isPlainObject(input.terminalSource)) {
    problems.push("optional field \"terminalSource\" must be a plain object when present");
  }
  if (input.baseEvidence !== undefined && !isPlainObject(input.baseEvidence)) {
    problems.push("optional field \"baseEvidence\" must be a plain object when present");
  }
  return { ok: problems.length === 0, problems };
}

// ── HarnessModuleResult（单模块结果 = moduleRun）──────────────────────────────
/**
 * 单模块结果（normalizeHarnessModuleRun 产出，存入 HarnessRun.moduleRuns[]）。
 * 必填: moduleId(string) / kind(4 类之一) / status(string)。
 * 可选(已在用): summary / reason(string) / hardShaped(string[]) / evidence(object|null) /
 *   startedAt / finalizedAt(number)。
 * @param {unknown} result
 * @returns {{ ok: boolean, problems: string[] }}
 */
export function validateHarnessModuleResult(result) {
  const problems = [];
  if (!isPlainObject(result)) {
    return { ok: false, problems: ["module result must be a plain object"] };
  }
  const moduleId = result.moduleId || result.id;
  if (!moduleId || typeof moduleId !== "string") {
    problems.push("required field \"moduleId\" is missing or not a string");
  }
  checkKind(result.kind, problems, { required: true });
  if (!result.status || typeof result.status !== "string") {
    problems.push("required field \"status\" is missing or not a string");
  }
  if (result.hardShaped !== undefined && !Array.isArray(result.hardShaped)) {
    problems.push("optional field \"hardShaped\" must be an array when present");
  }
  if (result.evidence !== undefined && result.evidence !== null && !isPlainObject(result.evidence)) {
    problems.push("optional field \"evidence\" must be a plain object or null when present");
  }
  return { ok: problems.length === 0, problems };
}

// ── HarnessRun（run 级聚合 = 唯一 run 级事实源）────────────────────────────────
/**
 * run 级聚合（normalizeHarnessRun 产出）。
 * 必填: automationId(string) / round(正整数) / status(string)。
 * 可选(已在用): id / moduleRuns(HarnessModuleResult[]) / score / artifact / summary /
 *   contractId / pipelineId / loopId / terminalStatus / gateSummary / reviewerResult 等。
 * 预留: schemaVersion —— P2/P4 加字段时用的演化槽（此处仅校验类型，不实现演化逻辑，见 P7）。
 * @param {unknown} run
 * @returns {{ ok: boolean, problems: string[] }}
 */
export function validateHarnessRun(run) {
  const problems = [];
  if (!isPlainObject(run)) {
    return { ok: false, problems: ["harness run must be a plain object"] };
  }
  const automationId = run.automationId || run.id;
  if (!automationId || typeof automationId !== "string") {
    problems.push("required field \"automationId\" is missing or not a string");
  }
  if (!Number.isInteger(run.round) || run.round <= 0) {
    problems.push("required field \"round\" must be a positive integer");
  }
  if (!run.status || typeof run.status !== "string") {
    problems.push("required field \"status\" is missing or not a string");
  }
  if (run.moduleRuns !== undefined) {
    if (!Array.isArray(run.moduleRuns)) {
      problems.push("optional field \"moduleRuns\" must be an array when present");
    } else {
      run.moduleRuns.forEach((mr, i) => {
        const check = validateHarnessModuleResult(mr);
        if (!check.ok) problems.push(`moduleRuns[${i}] invalid: ${check.problems.join("; ")}`);
      });
    }
  }
  // schemaVersion 预留槽：present 时必须是非负整数；不实现演化逻辑（P7）。
  if (run.schemaVersion !== undefined
    && !(Number.isInteger(run.schemaVersion) && run.schemaVersion >= 0)) {
    problems.push("reserved field \"schemaVersion\" must be a non-negative integer when present");
  }
  return { ok: problems.length === 0, problems };
}

// ── Meta-harness 校验：新模块接入时被强制问全套（标准倒逼标准）──────────────────
// 设计来源（备忘录113 §5.1）：标准化拼图倒逼新 harness 同形。新模块接入时不能只声明
// id/kind，必须答全套：kind / 输入输出契约 / 产什么 evidence key / failure_class / 属
// hard|soft|freeform 哪层。不合规 = **非静默拒绝**（返回 problems 由接入流程拦截）。
//
// 注意：这是给「新模块接入」用的严格闸，与 validateHarnessModuleDefinition（catalog
// 入库的轻量闸，只校 id/kind/hardShaped）分工——后者保持不变，避免破坏既有 10 个
// catalog 条目（它们先于全套契约存在）。

// run-shape 三层（本地常量，避免 run-shape-map→catalog→schema 循环引用；
// 与 run-shape-map.js VALID_RUN_SHAPE_LAYERS 保持一致）。
const META_RUN_SHAPE_LAYERS = Object.freeze(["hardShaped", "softGuided", "freeform"]);

function checkStringArrayField(value, fieldName, problems, { allowEmpty = false } = {}) {
  if (!Array.isArray(value)) {
    problems.push(`required field "${fieldName}" must be an array`);
    return;
  }
  if (!allowEmpty && value.length === 0) {
    problems.push(`required field "${fieldName}" must be a non-empty array`);
  }
  const nonStrings = value.filter((item) => typeof item !== "string" || !item);
  if (nonStrings.length > 0) {
    problems.push(`"${fieldName}" must be an array of non-empty strings`);
  }
}

/**
 * 校验「新模块接入」是否答全 meta-harness 全套问卷。
 *
 * 在 validateHarnessModuleDefinition（id/kind/hardShaped）基础上，**强制**追加：
 *   - ioContract        {object}    输入输出契约：{ inputs:string[], outputs:string[] }
 *   - evidenceKeys      {string[]}  产出哪些 evidence key（每个须 ∈ HARNESS_EVIDENCE_KEY 值集）
 *   - failureClasses    {string[]}  可能产出的 failure_class（每个须 ∈ KNOWN_HARNESS_FAILURE_CLASSES）
 *   - shapeLayer        {string}    属 hardShaped|softGuided|freeform 哪层
 *
 * @param {unknown} spec
 * @returns {{ ok: boolean, problems: string[] }}
 */
export function validateMetaHarnessModuleSpec(spec) {
  // 先过基础定义闸（id/kind/hardShaped）
  const base = validateHarnessModuleDefinition(spec);
  const problems = [...base.problems];
  if (!isPlainObject(spec)) {
    return { ok: false, problems };
  }

  // 输入输出契约
  if (!isPlainObject(spec.ioContract)) {
    problems.push("required field \"ioContract\" must be a plain object { inputs, outputs }");
  } else {
    checkStringArrayField(spec.ioContract.inputs, "ioContract.inputs", problems, { allowEmpty: true });
    checkStringArrayField(spec.ioContract.outputs, "ioContract.outputs", problems, { allowEmpty: true });
  }

  // 产什么 evidence key（须 ∈ 词汇表）
  checkStringArrayField(spec.evidenceKeys, "evidenceKeys", problems, { allowEmpty: true });
  if (Array.isArray(spec.evidenceKeys)) {
    const allowed = new Set(Object.values(HARNESS_EVIDENCE_KEY));
    const unknown = spec.evidenceKeys.filter((k) => typeof k === "string" && !allowed.has(k));
    if (unknown.length > 0) {
      problems.push(`"evidenceKeys" contains keys not in HARNESS_EVIDENCE_KEY: [${unknown.join(", ")}]`);
    }
  }

  // failure_class（须 ∈ 归一清单）
  checkStringArrayField(spec.failureClasses, "failureClasses", problems, { allowEmpty: true });
  if (Array.isArray(spec.failureClasses)) {
    const allowed = new Set(KNOWN_HARNESS_FAILURE_CLASSES);
    const unknown = spec.failureClasses.filter((k) => typeof k === "string" && !allowed.has(k));
    if (unknown.length > 0) {
      problems.push(`"failureClasses" contains classes not in KNOWN_HARNESS_FAILURE_CLASSES: [${unknown.join(", ")}]`);
    }
  }

  // 属 hard|soft|freeform 哪层
  if (!META_RUN_SHAPE_LAYERS.includes(spec.shapeLayer)) {
    problems.push(`required field "shapeLayer" must be one of [${META_RUN_SHAPE_LAYERS.join(", ")}], got "${spec.shapeLayer}"`);
  }

  return { ok: problems.length === 0, problems };
}
