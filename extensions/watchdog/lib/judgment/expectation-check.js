// lib/judgment/expectation-check.js — 判决面。全部内容就这一个文件。
//
// 判决 = 系统级机械核对,零 LLM:拿甲方派工时写下的期望(expectations),对着盘上
// 的事实看齐不齐;不齐就报"不太对"。内容级评审(评审导向 executor 读产物写意见)不在
// 这里——那是执行面在干活,活的内容恰好叫审查而已。
//
// 三分结构里本文件是 ②:
//   ① 记录  运行中保存的事实(采集结果、agent 声明、写盘)      —— lib/round 之外既有机制
//   ② 判决  期望 vs 事实的机械核对                              —— 本文件
//   ③ 执行  agent 干活、合约流转、按事实收口                    —— 其余一切
//
// 可拔除性:零期望时返回空结果(「没有可核对的东西」,不冒充合格——旧考官 241 条判决
// 里 185 条零期望空判 fulfilled,就是死在这一步冒充上)。收口路径在判决报缺时才把
// 合约标失败;判决不报,收口按事实走。

import { readFile, stat } from "node:fs/promises";
import { classifyToolFailureResidue } from "../delivery/runtime-user-facing-output.js";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { normalizeString } from "../core/normalize.js";

const HOME = homedir();

function readJsonPath(parsed, jsonPath) {
  const segments = String(jsonPath || "").split(".").filter(Boolean);
  let cursor = parsed;
  for (const segment of segments) {
    if (cursor == null || typeof cursor !== "object") return null;
    cursor = cursor[segment];
  }
  return cursor;
}

// 单文件机械核对:存在 → 非空 → 非工具失败残渣 → jsonPaths 命中。
// 每一条都是平台可自证的检查,没有任何一条需要理解内容——
// 内容长相启发式(裸标记 control_text 类)已随 2026-08-17 拆分裁定移除:
// 甲方点名要求写入的就是标记时,按长相判缺失=启发式替甲方改口;
// 工具失败残渣(错误回声/路径残渣)是"写入其实失败了"的事实识别,保留。
async function inspectArtifact(requirement) {
  const normalizedPath = resolve(String(requirement.path).replace(/^~/, HOME));
  try {
    const fileStat = await stat(normalizedPath);
    if (!fileStat.isFile()) {
      return { ok: false, label: requirement.label, path: normalizedPath, reason: "not_a_file" };
    }
    if (requirement.nonEmpty && fileStat.size <= 0) {
      return { ok: false, label: requirement.label, path: normalizedPath, reason: "empty_file" };
    }
    {
      const raw = await readFile(normalizedPath, "utf8");
      const failureResidue = classifyToolFailureResidue(raw, { outputPath: normalizedPath });
      if (failureResidue) {
        return { ok: false, label: requirement.label, path: normalizedPath, reason: `invalid_semantic_payload:${failureResidue}` };
      }
    }
    if (requirement.jsonPaths?.length) {
      const raw = await readFile(normalizedPath, "utf8");
      const parsed = JSON.parse(raw);
      for (const jsonPath of requirement.jsonPaths) {
        if (readJsonPath(parsed, jsonPath) == null) {
          return { ok: false, label: requirement.label, path: normalizedPath, reason: `missing_json_path:${jsonPath}` };
        }
      }
    }
    return { ok: true, label: requirement.label, path: normalizedPath };
  } catch (e) {
    return {
      ok: false,
      label: requirement.label,
      path: normalizedPath,
      reason: e.code === "ENOENT" ? "missing_file" : e.message,
    };
  }
}

function normalizeRequirement(entry) {
  if (typeof entry === "string") {
    const path = normalizeString(entry);
    return path ? { path, label: path, nonEmpty: true, jsonPaths: [] } : null;
  }
  if (!entry || typeof entry !== "object") return null;
  const path = normalizeString(entry.path);
  if (!path) return null;
  return {
    path,
    label: normalizeString(entry.label) || path,
    nonEmpty: entry.nonEmpty !== false,
    jsonPaths: Array.isArray(entry.jsonPaths) ? entry.jsonPaths.filter(Boolean) : [],
  };
}

/**
 * 核对甲方期望。期望来自派工方(assign_task 参数或 completionCriteria.requiredFiles),
 * 平台不代填——零期望就是零核对,返回空结果,让收口按事实走。
 *
 * @returns {{ checked: Array, missing: Array }} missing 非空 = "不太对",附每条差在哪。
 */
export async function checkExpectations({ requiredFiles = null, requiredArtifacts = null } = {}) {
  const requirements = []
    .concat(Array.isArray(requiredFiles) ? requiredFiles : [])
    .concat(Array.isArray(requiredArtifacts) ? requiredArtifacts : [])
    .map(normalizeRequirement)
    .filter(Boolean);
  if (requirements.length === 0) {
    return { checked: [], missing: [] };
  }
  const checked = [];
  for (const requirement of requirements) {
    checked.push(await inspectArtifact(requirement));
  }
  return { checked, missing: checked.filter((entry) => !entry.ok) };
}
