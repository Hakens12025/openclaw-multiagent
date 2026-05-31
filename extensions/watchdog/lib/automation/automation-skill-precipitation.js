// automation-skill-precipitation.js — skill 因果链自动沉淀（④，Hermes 启发，证据链评判）
//
// 设计（用户精炼，比 Hermes "抽产物全文" 精炼）：skill 不存产物全文，存**验证过的因果对错边界**。
//   ## 情况(When) ← 从 HarnessRun 的 contract/task/profile 抽
//   ## Pro(对)    ← 来自高分成功 HarnessRun（verdict pass/improved + gate 过）+ moduleRuns evidence
//   ## Con(错)    ← 来自同任务族失败 HarnessRun 的 failure_class（复用 P0 HARNESS_FAILURE_CLASS）
//
// vs Hermes 关键差异：**评判用代码（EvaluationResult 阈值 + HarnessRun evidence），不是 LLM 自评**。
// 每条 pro/con 挂 evidence 来源（harnessRunId / failureClass）= 验证后的因果，非 LLM 拍脑袋。
//
// 复用（不造第二真值）：progressive disclosure（SKILL.md 经现有注入）、HARNESS_FAILURE_CLASS（P0）、
//   ProfileLifecycle.successStreak（P4）、FAILURE_CLASS_STRATEGIES（P0）。
// 守概念预算：skill 是已有概念；本文件是流程（代码），与 ProfileLifecycle（调流程参数）不重叠（积累内容知识）。

import { mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";

import { OC } from "../state-paths.js";
import { atomicWriteFile } from "../state-file-utils.js";
import { normalizeRecord, normalizeString } from "../core/normalize.js";
import {
  FAILURE_CLASS_STRATEGIES,
  HARNESS_EVIDENCE_KEY,
} from "../harness/harness-evidence-vocab.js";

const SKILLS_DIR = join(OC, "skills");
const PRECIPITATED_PREFIX = "learned-";

// 沉淀阈值（代码判，非 LLM 自评）。可经 spec.skillPrecipitation 覆盖。
const DEFAULT_SCORE_THRESHOLD = 0.7;   // 归一到 [0,1]（按 scoreMax）
const DEFAULT_MIN_SUCCESS_STREAK = 2;  // 连续成功才沉淀，避免一次性侥幸（复用 ProfileLifecycle streak）
const PRECIPITATE_VERDICTS = new Set(["pass", "improved"]);

function readPrecipitationConfig(spec) {
  const cfg = normalizeRecord(spec?.skillPrecipitation, {});
  return {
    enabled: cfg.enabled !== false, // 默认开
    scoreThreshold: Number.isFinite(cfg.scoreThreshold) ? cfg.scoreThreshold : DEFAULT_SCORE_THRESHOLD,
    minSuccessStreak: Number.isFinite(cfg.minSuccessStreak) ? cfg.minSuccessStreak : DEFAULT_MIN_SUCCESS_STREAK,
    scoreMax: Number.isFinite(cfg.scoreMax) ? cfg.scoreMax : (Number.isFinite(spec?.harness?.scoreMax) ? spec.harness.scoreMax : 1),
  };
}

function normalizeScore(score, scoreMax) {
  if (!Number.isFinite(score)) return null;
  if (Number.isFinite(scoreMax) && scoreMax > 1) return score / scoreMax;
  return score;
}

// ── 评判：代码判 EvaluationResult 阈值 + ProfileLifecycle streak（不让 LLM 判值不值得）─────
export function shouldPrecipitateSkill({ spec, evaluationResult, profileLifecycle, harnessRun } = {}) {
  const config = readPrecipitationConfig(spec);
  if (!config.enabled) return { precipitate: false, reason: "disabled" };

  // 沉淀的知识挂在「任务族（harness profile）」上，不挂一次性 automation id。
  // 无 harness.profileId 的临时 automation（含测试 fixture）没有稳定族身份 → 不沉淀。
  if (!normalizeString(spec?.harness?.profileId)) {
    return { precipitate: false, reason: "no_profile_id" };
  }

  const er = normalizeRecord(evaluationResult, null);
  if (!er) return { precipitate: false, reason: "no_evaluation_result" };

  const verdict = normalizeString(er.verdict)?.toLowerCase();
  if (!PRECIPITATE_VERDICTS.has(verdict)) {
    return { precipitate: false, reason: `verdict_not_success(${verdict || "none"})` };
  }

  // gate 必须过（无失败模块）才算成功路径。
  const gate = normalizeRecord(harnessRun?.gateSummary, {});
  if (Number(gate.failed || 0) > 0 || normalizeString(gate.verdict)?.toLowerCase() === "failed") {
    return { precipitate: false, reason: "gate_not_passed" };
  }

  const normScore = normalizeScore(er.score, config.scoreMax);
  if (normScore != null && normScore < config.scoreThreshold) {
    return { precipitate: false, reason: `score_below_threshold(${normScore}<${config.scoreThreshold})` };
  }

  const successStreak = Number(profileLifecycle?.successStreak || 0);
  if (successStreak < config.minSuccessStreak) {
    return { precipitate: false, reason: `streak_below_min(${successStreak}<${config.minSuccessStreak})` };
  }

  return { precipitate: true, reason: "verified_success", normScore, successStreak };
}

// ── 抽 When：从成功 HarnessRun 的 contract/task/profile 抽"什么情况" ───────────────────
function extractWhen(harnessRun, spec) {
  const profileId = normalizeString(harnessRun?.profileId || spec?.harness?.profileId) || null;
  const objective = normalizeString(spec?.objective?.summary || spec?.objective?.domain) || null;
  const summary = normalizeString(harnessRun?.summary) || null;
  const parts = [];
  if (profileId) parts.push(`harness profile = ${profileId}`);
  if (objective) parts.push(`目标 = ${objective}`);
  if (summary) parts.push(`本轮任务摘要 = ${summary}`);
  return parts.length > 0 ? parts.join("；") : "（无法从 HarnessRun 抽出明确情况）";
}

// ── 抽 Pro：从成功 HarnessRun 的 gate 过路径 + moduleRuns evidence 抽（挂 harnessRunId）──────
function extractPros(harnessRun) {
  const runId = normalizeString(harnessRun?.id) || null;
  const pros = [];
  const moduleRuns = Array.isArray(harnessRun?.moduleRuns) ? harnessRun.moduleRuns : [];
  for (const mr of moduleRuns) {
    if (normalizeString(mr?.status)?.toLowerCase() !== "passed") continue;
    const ev = normalizeRecord(mr?.evidence, {});
    const detail = normalizeString(mr?.summary)
      || normalizeString(ev[HARNESS_EVIDENCE_KEY.TEST_SIGNAL]?.signal)
      || normalizeString(mr?.moduleId);
    if (!detail) continue;
    pros.push({
      statement: `模块 ${mr.moduleId}（${mr.kind}）通过：${detail}`,
      evidence: { harnessRunId: runId, moduleId: normalizeString(mr.moduleId) },
    });
  }
  // 兜底：至少挂 gate 过的整体证据（成功 HarnessRun 背书）。
  if (pros.length === 0 && runId) {
    pros.push({
      statement: "本轮 gate 全过、reviewer 判定成功，该做法路径已被验证有效。",
      evidence: { harnessRunId: runId, gateVerdict: normalizeString(harnessRun?.gateSummary?.verdict) || "passed" },
    });
  }
  return pros;
}

// ── 抽 Con：从同任务族失败 HarnessRun 的 failure_class 抽（挂 failureClass）。无证据则留空 ──────
function extractCons(recentHarnessRuns, spec) {
  const profileId = normalizeString(spec?.harness?.profileId) || null;
  const runs = Array.isArray(recentHarnessRuns) ? recentHarnessRuns : [];
  const cons = [];
  const seenClasses = new Set();
  for (const run of runs) {
    // 同任务族（同 profile）才相关。
    if (profileId && normalizeString(run?.profileId) && normalizeString(run.profileId) !== profileId) continue;
    const gate = normalizeRecord(run?.gateSummary, {});
    const failed = Number(gate.failed || 0) > 0 || normalizeString(run?.terminalStatus)?.toLowerCase() === "failed";
    if (!failed) continue;
    // 从 moduleRuns evidence 取 failureClass（P0 词汇表）。
    const moduleRuns = Array.isArray(run?.moduleRuns) ? run.moduleRuns : [];
    for (const mr of moduleRuns) {
      const ev = normalizeRecord(mr?.evidence, {});
      const failureClass = normalizeString(ev[HARNESS_EVIDENCE_KEY.FAILURE_CLASS]);
      if (!failureClass || seenClasses.has(failureClass)) continue;
      seenClasses.add(failureClass);
      const strategy = FAILURE_CLASS_STRATEGIES[failureClass] || null;
      cons.push({
        statement: strategy
          ? `避免导致 ${failureClass} 的做法；应对策略：${strategy}。`
          : `避免导致 ${failureClass} 的做法。`,
        evidence: { harnessRunId: normalizeString(run.id) || null, failureClass, moduleId: normalizeString(mr.moduleId) },
      });
    }
  }
  return cons; // 没有失败证据 → 空数组（只留验证后的，不编）
}

// originHash：用于去重（同情况+同 pro/con 集只沉淀一次）。
function computeOriginHash({ when, pros, cons }) {
  const payload = JSON.stringify({
    when,
    pros: pros.map((p) => p.statement),
    cons: cons.map((c) => c.statement),
  });
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

// ── 抽因果对（纯函数）──────────────────────────────────────────────────────────
export function extractCausalSkill({ spec, harnessRun, evaluationResult, recentHarnessRuns } = {}) {
  // 沉淀挂任务族（harness profile）；无 profileId 不沉淀（与 shouldPrecipitateSkill 一致）。
  const profileId = normalizeString(spec?.harness?.profileId);
  if (!profileId) return null;
  const when = extractWhen(harnessRun, spec);
  const pros = extractPros(harnessRun);
  const cons = extractCons(recentHarnessRuns, spec);
  // Pro 必须有成功 evidence；无 Pro 则不沉淀（没验证过的不写）。
  if (pros.length === 0) return null;
  const originHash = computeOriginHash({ when, pros, cons });
  const skillName = `${PRECIPITATED_PREFIX}${profileId.replace(/[^a-z0-9_.-]/gi, "-")}`;
  return {
    name: skillName,
    profileId,
    when,
    pros,
    cons,
    originHash,
    source: {
      harnessRunId: normalizeString(harnessRun?.id) || null,
      evaluationResultId: normalizeString(evaluationResult?.id || evaluationResult?.evaluationResultId) || null,
      originHash,
      precipitatedAt: Date.now(),
    },
  };
}

function buildSkillMarkdown(skill) {
  const description = `已验证因果边界（${skill.profileId}）：什么情况下怎么做对/做错，附证据链。`;
  const proLines = skill.pros.map((p) => `- ${p.statement} _[evidence: ${JSON.stringify(p.evidence)}]_`);
  const conLines = skill.cons.length > 0
    ? skill.cons.map((c) => `- ${c.statement} _[evidence: ${JSON.stringify(c.evidence)}]_`)
    : ["- （暂无失败证据；只留验证后的因果，不编造。）"];
  return [
    "---",
    `name: ${skill.name}`,
    `description: ${description}`,
    "---",
    "",
    `# ${skill.name}`,
    "",
    "> 本 skill 由因果链自动沉淀（代码判评判 + HarnessRun 证据链背书），非 LLM 自评招式。",
    "",
    "## 情况（When）",
    "",
    skill.when,
    "",
    "## Pro（对：来自高分成功 HarnessRun）",
    "",
    ...proLines,
    "",
    "## Con（错：来自失败 failure_class）",
    "",
    ...conLines,
    "",
  ].join("\n");
}

async function findExistingByOriginHash(skillDir, originHash) {
  try {
    const sourceRaw = await readFile(join(skillDir, "SOURCE.json"), "utf8");
    const source = JSON.parse(sourceRaw);
    return normalizeString(source?.originHash) === originHash;
  } catch {
    return false;
  }
}

// ── 写 SKILL.md + SOURCE.json + 去重 ───────────────────────────────────────────
export async function precipitateSkill({ skill, logger = null } = {}) {
  if (!skill) return { written: false, reason: "no_skill" };
  const skillDir = join(SKILLS_DIR, skill.name);

  if (await findExistingByOriginHash(skillDir, skill.originHash)) {
    return { written: false, reason: "duplicate_origin_hash", originHash: skill.originHash, skillName: skill.name };
  }

  await mkdir(skillDir, { recursive: true });
  await atomicWriteFile(join(skillDir, "SKILL.md"), buildSkillMarkdown(skill));
  await atomicWriteFile(join(skillDir, "SOURCE.json"), JSON.stringify(skill.source, null, 2));
  logger?.info?.(`[watchdog] skill precipitated: ${skill.name} (originHash=${skill.originHash})`);
  return {
    written: true,
    skillName: skill.name,
    skillDir,
    originHash: skill.originHash,
    proCount: skill.pros.length,
    conCount: skill.cons.length,
  };
}

// ── 编排：触发点调用（finalize 尾段）。返回结果供 onAlert/日志，失败不影响主流程 ──────────
export async function maybePrecipitateSkillFromRound({
  spec,
  harnessRun,
  evaluationResult,
  profileLifecycle,
  recentHarnessRuns,
  logger = null,
  onAlert = null,
} = {}) {
  const gate = shouldPrecipitateSkill({ spec, evaluationResult, profileLifecycle, harnessRun });
  if (!gate.precipitate) {
    return { precipitated: false, reason: gate.reason };
  }
  const skill = extractCausalSkill({ spec, harnessRun, evaluationResult, recentHarnessRuns });
  if (!skill) {
    return { precipitated: false, reason: "no_pro_evidence" };
  }
  const result = await precipitateSkill({ skill, logger });
  if (result.written) {
    onAlert?.({
      type: "skill_precipitated",
      automationId: normalizeString(spec?.id) || null,
      skillName: result.skillName,
      originHash: result.originHash,
      proCount: result.proCount,
      conCount: result.conCount,
      harnessRunId: skill.source.harnessRunId,
      evaluationResultId: skill.source.evaluationResultId,
      ts: Date.now(),
    });
  }
  return { precipitated: result.written, ...result };
}
