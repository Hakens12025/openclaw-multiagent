// tests/suite-model.js — Model comparison test infrastructure + report

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execSync } from "node:child_process";
import {
  readStoredAgentBinding,
  writeStoredAgentBinding,
} from "../lib/agent/agent-binding-store.js";
import { OC, CONFIG_FILE, PORT, fetchJSON, sleep } from "./infra.js";
import { summarizeTestDiagnosis } from "./suite-single.js";

export const MODEL_PROFILES = [
  { provider: "ark-openai", modelId: "minimax-m2.5", label: "MiniMax M2.5 (ARK)" },
];

export const MODEL_TEST_CASES = [
  {
    id: "m-simple",
    message: "1+1等于几",
    expectedPath: "fast-track",
    timeoutMs: 120000,
    validateOutput: { minBytes: 5, keywords: ["2"] },
    scoring: { contractFormat: 2, outputQuality: 3, toolUsage: 1, completionSpeed: 4 },
    category: "simple",
  },
  {
    id: "m-instruct",
    message: "对比 React 和 Vue 框架的优缺点，写一份报告",
    expectedPath: "full-path",
    timeoutMs: 300000,
    validateOutput: { minBytes: 200, keywords: ["React", "Vue"] },
    scoring: { contractFormat: 3, outputQuality: 3, toolUsage: 2, completionSpeed: 2 },
    category: "instruction",
  },
];

function normalizeAgentRole(agent) {
  return readStoredAgentBinding(agent)?.roleRef || null;
}

function isPlannerAgentConfig(agent) {
  return normalizeAgentRole(agent) === "planner" || agent?.id === "contractor";
}

function isExecutorAgentConfig(agent) {
  return normalizeAgentRole(agent) === "executor" || String(agent?.id || "").startsWith("worker-");
}

function isGatewayAgentConfig(agent) {
  return readStoredAgentBinding(agent)?.policies?.gateway === true;
}

function setAgentModel(agent, fullModel) {
  const binding = readStoredAgentBinding(agent);
  writeStoredAgentBinding(agent, {
    ...binding,
    model: {
      ref: fullModel,
    },
  });
}

export function listModelSwapTargets(cfg, { includeGateway = false } = {}) {
  return (Array.isArray(cfg?.agents?.list) ? cfg.agents.list : [])
    .filter((agent) =>
      isPlannerAgentConfig(agent)
      || isExecutorAgentConfig(agent)
      || (includeGateway && isGatewayAgentConfig(agent)))
    .map((agent) => agent.id);
}

export async function swapModel(provider, modelId) {
  const raw = await readFile(CONFIG_FILE, "utf8");
  const cfg = JSON.parse(raw);
  const fullModel = `${provider}/${modelId}`;
  const targetAgentIds = new Set(listModelSwapTargets(cfg));
  for (const agent of cfg.agents.list) {
    if (targetAgentIds.has(agent.id)) {
      setAgentModel(agent, fullModel);
    }
  }
  await writeFile(CONFIG_FILE, JSON.stringify(cfg, null, 2), "utf8");
  console.log(`  Config updated: planner + executors → ${fullModel} (${[...targetAgentIds].join(", ")})`);
}

export async function swapModelComplete(provider, modelId) {
  const raw = await readFile(CONFIG_FILE, "utf8");
  const cfg = JSON.parse(raw);
  const fullModel = `${provider}/${modelId}`;
  const targetAgentIds = new Set(listModelSwapTargets(cfg, { includeGateway: true }));
  for (const agent of cfg.agents.list) {
    if (targetAgentIds.has(agent.id)) {
      setAgentModel(agent, fullModel);
    }
  }
  await writeFile(CONFIG_FILE, JSON.stringify(cfg, null, 2), "utf8");
  console.log(`  Config updated: gateways + planner + executors → ${fullModel} (${[...targetAgentIds].join(", ")})`);
}

export async function restartGateway() {
  console.log("  Stopping gateway...");
  try {
    execSync("openclaw gateway stop", { timeout: 15000, stdio: "pipe" });
  } catch {}
  await sleep(3000);

  console.log("  Starting gateway...");
  execSync(`cd ${OC} && nohup openclaw gateway run > /tmp/openclaw-gateway.log 2>&1 &`, {
    timeout: 10000,
    stdio: "pipe",
    shell: true,
  });

  for (let i = 0; i < 20; i++) {
    await sleep(2000);
    try {
      await fetchJSON("/watchdog/runtime");
      console.log("  Gateway online.");
      return true;
    } catch {}
  }
  console.log("  WARNING: Gateway did not come online within 40s");
  return false;
}

export async function restoreOriginalModel(origModels) {
  const raw = await readFile(CONFIG_FILE, "utf8");
  const cfg = JSON.parse(raw);
  for (const agent of cfg.agents.list) {
    if (origModels[agent.id]) setAgentModel(agent, origModels[agent.id]);
  }
  await writeFile(CONFIG_FILE, JSON.stringify(cfg, null, 2), "utf8");
}

export function generateModelComparisonReport(allModelResults, totalDuration, strategy = "PARTIAL") {
  const lines = [];
  const now = new Date().toISOString().replace("T", " ").slice(0, 19);
  const strategyLabel = strategy === "COMPLETE CHANGE"
    ? "COMPLETE CHANGE (gateways + planner + executors swapped)"
    : "PARTIAL (planner + executors swapped)";

  lines.push("══════════════════════════════════════════════════════════════════");
  lines.push(" OPENCLAW MODEL COMPARISON REPORT");
  lines.push(` Strategy: ${strategyLabel}`);
  lines.push(` Run: ${now}  Duration: ${totalDuration}s`);
  lines.push(` Models tested: ${allModelResults.length}`);
  lines.push(` Test cases per model: ${MODEL_TEST_CASES.length} (${MODEL_TEST_CASES.map(t => t.id).join(", ")})`);
  lines.push("══════════════════════════════════════════════════════════════════");
  lines.push("");

  const ranked = allModelResults
    .map(mr => {
      const totalScore = mr.benchResults.reduce((s, br) => s + br.benchScore.total, 0);
      const totalMax = mr.benchResults.reduce((s, br) => s + br.benchScore.max, 0);
      const passCount = mr.benchResults.filter(br => br.testResult.pass).length;
      const avgDuration = mr.benchResults.filter(br => br.testResult.pass).length > 0
        ? (mr.benchResults.filter(br => br.testResult.pass).reduce((s, br) => s + parseFloat(br.testResult.duration), 0) /
           mr.benchResults.filter(br => br.testResult.pass).length).toFixed(1)
        : "N/A";
      return { ...mr, totalScore, totalMax, passCount, avgDuration, pct: totalMax > 0 ? Math.round(totalScore / totalMax * 100) : 0 };
    })
    .sort((a, b) => b.pct - a.pct || parseFloat(a.avgDuration) - parseFloat(b.avgDuration));

  lines.push("── RANKING ──────────────────────────────────────────────────────");
  lines.push("");
  lines.push(" #  | Model                      | Score      | Pass | Avg Time");
  lines.push("----+----------------------------+------------+------+---------");
  ranked.forEach((mr, i) => {
    const rank = String(i + 1).padStart(2);
    const label = mr.profile.label.padEnd(26);
    const score = `${mr.totalScore}/${mr.totalMax} (${mr.pct}%)`.padEnd(10);
    const pass = `${mr.passCount}/${mr.benchResults.length}`.padEnd(4);
    lines.push(` ${rank} | ${label} | ${score} | ${pass} | ${mr.avgDuration}s`);
  });
  lines.push("");

  lines.push("── DIMENSION SCORES ─────────────────────────────────────────────");
  lines.push("");
  const dims = ["contractFormat", "outputQuality", "toolUsage", "completionSpeed"];
  const header = " Model".padEnd(28) + dims.map(d => d.slice(0, 10).padStart(12)).join("");
  lines.push(header);
  lines.push("-".repeat(header.length));

  for (const mr of ranked) {
    const label = mr.profile.label.padEnd(26);
    const dimScores = dims.map(dim => {
      const t = mr.benchResults.reduce((s, br) => s + (br.benchScore.scores[dim] || 0), 0);
      const m = mr.benchResults.reduce((s, br) => s + (br.benchScore.maxScores[dim] || 0), 0);
      return m > 0 ? `${t}/${m}`.padStart(12) : "N/A".padStart(12);
    }).join("");
    lines.push(` ${label} ${dimScores}`);
  }
  lines.push("");

  lines.push("── DETAILED RESULTS ─────────────────────────────────────────────");
  for (const mr of ranked) {
    lines.push("");
    lines.push(`┌─ ${mr.profile.label} (${mr.profile.provider}/${mr.profile.modelId}) ─`);

    if (mr.error) {
      lines.push(`│  ERROR: ${mr.error}`);
      lines.push("└─");
      continue;
    }

    for (const br of mr.benchResults) {
      const { testResult, benchScore, testCase } = br;
      const pathLabel = testResult.isFastTrack === true ? "FAST-TRACK" : "FULL-PATH";
      const result = testResult.pass ? "PASS" : "FAIL";
      lines.push(`│  ${testCase.id}: ${result} | ${pathLabel} | ${testResult.duration}s | ${benchScore.total}/${benchScore.max} (${Math.round(benchScore.total/benchScore.max*100)}%)`);

      if (!testResult.pass && testResult.results) {
        const diagnosis = summarizeTestDiagnosis(testResult);
        if (diagnosis) lines.push(`│    diagnosis: [${diagnosis.subsystem}] ${diagnosis.conclusion}`);
      }

      for (const d of benchScore.details) {
        lines.push(`│    ${d}`);
      }
    }
    lines.push("└─");
  }

  lines.push("");
  lines.push("── RECOMMENDATIONS ──────────────────────────────────────────────");
  lines.push("");

  if (ranked.length > 0 && ranked[0].pct > 0) {
    lines.push(` Best Overall:    ${ranked[0].profile.label} (${ranked[0].pct}%)`);
  }

  for (const dim of dims) {
    let bestLabel = "N/A", bestPct = 0;
    for (const mr of ranked) {
      const t = mr.benchResults.reduce((s, br) => s + (br.benchScore.scores[dim] || 0), 0);
      const m = mr.benchResults.reduce((s, br) => s + (br.benchScore.maxScores[dim] || 0), 0);
      const p = m > 0 ? t / m * 100 : 0;
      if (p > bestPct) { bestPct = p; bestLabel = mr.profile.label; }
    }
    lines.push(` Best ${dim.padEnd(18)}: ${bestLabel} (${Math.round(bestPct)}%)`);
  }

  const fastest = ranked.filter(mr => mr.avgDuration !== "N/A").sort((a, b) => parseFloat(a.avgDuration) - parseFloat(b.avgDuration));
  if (fastest.length > 0) {
    lines.push(` Fastest:          ${fastest[0].profile.label} (${fastest[0].avgDuration}s avg)`);
  }

  lines.push("");
  lines.push("══════════════════════════════════════════════════════════════════");

  return lines.join("\n");
}
