// tests/suite-benchmark.js — Benchmark evaluation + report generator

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { OUTPUT_DIR, PORT } from "./infra.js";
import { summarizeTestDiagnosis } from "./suite-single.js";

// ── Benchmark Cases ───────────────────────────────────────────────────────────

export const BENCHMARK_CASES = [
  {
    id: "bench-instruct-01", category: "instruction",
    message: "研究北京最近三天天气并总结趋势",
    expectedPath: "full-path", timeoutMs: 180000,
    validateOutput: { minBytes: 200, keywords: ["天气", "趋势", "北京"] },
    scoring: { contractFormat: 3, outputQuality: 3, toolUsage: 2, completionSpeed: 2 },
  },
  {
    id: "bench-instruct-02", category: "instruction",
    message: "对比 React 和 Vue 框架的优缺点，写一份 500 字以上的报告",
    expectedPath: "full-path", timeoutMs: 180000,
    validateOutput: { minBytes: 500, keywords: ["React", "Vue", "优", "缺"] },
    scoring: { contractFormat: 3, outputQuality: 3, toolUsage: 2, completionSpeed: 2 },
  },
  {
    id: "bench-simple-01", category: "simple",
    message: "今天星期几",
    expectedPath: "fast-track", timeoutMs: 60000,
    validateOutput: { minBytes: 10 },
    scoring: { contractFormat: 2, outputQuality: 2, toolUsage: 1, completionSpeed: 5 },
  },
  {
    id: "bench-simple-02", category: "simple",
    message: "1+1等于几",
    expectedPath: "fast-track", timeoutMs: 60000,
    validateOutput: { minBytes: 5, keywords: ["2"] },
    scoring: { contractFormat: 2, outputQuality: 3, toolUsage: 1, completionSpeed: 4 },
  },
  {
    id: "bench-tool-01", category: "tool_usage",
    message: "搜索 Python 3.12 的新特性并总结",
    expectedPath: "full-path", timeoutMs: 180000,
    validateOutput: { minBytes: 200, keywords: ["Python"] },
    scoring: { contractFormat: 2, outputQuality: 3, toolUsage: 5, completionSpeed: 1 },
  },
];

export async function evaluateBenchmark(testResult, testCase) {
  const scores = { contractFormat: 0, outputQuality: 0, toolUsage: 0, completionSpeed: 0 };
  const maxScores = testCase.scoring || { contractFormat: 3, outputQuality: 3, toolUsage: 2, completionSpeed: 2 };
  const details = [];

  // 1. Contract Format
  if (testResult.pass) {
    scores.contractFormat = maxScores.contractFormat;
    details.push(`contractFormat: ${scores.contractFormat}/${maxScores.contractFormat} (full chain completed)`);
  } else {
    const results = testResult.results || [];
    const lastPass = results.filter(r => r.status === "PASS").length;
    scores.contractFormat = Math.floor(maxScores.contractFormat * lastPass / 13);
    details.push(`contractFormat: ${scores.contractFormat}/${maxScores.contractFormat} (${lastPass}/13 checkpoints)`);
  }

  // 2. Output Quality
  if (testResult.pass && testResult.contractId) {
    try {
      const outputFiles = await readdir(OUTPUT_DIR);
      const match = outputFiles.find(f => f.includes(testResult.contractId));
      if (match) {
        const content = await readFile(join(OUTPUT_DIR, match), "utf8");
        const bytes = Buffer.byteLength(content, "utf8");
        const validate = testCase.validateOutput || {};
        let qualityScore = 0;
        const qualityMax = maxScores.outputQuality;

        if (validate.minBytes && bytes >= validate.minBytes) {
          qualityScore += Math.ceil(qualityMax * 0.4);
          details.push(`  output size: ${bytes} bytes (>= ${validate.minBytes} required)`);
        } else if (validate.minBytes) {
          details.push(`  output size: ${bytes} bytes (< ${validate.minBytes} required) UNDER`);
        } else if (bytes > 10) {
          qualityScore += Math.ceil(qualityMax * 0.4);
        }

        if (validate.keywords && validate.keywords.length > 0) {
          const found = validate.keywords.filter(kw => content.includes(kw));
          const kwRatio = found.length / validate.keywords.length;
          qualityScore += Math.floor(qualityMax * 0.6 * kwRatio);
          details.push(`  keywords: ${found.length}/${validate.keywords.length} [${found.join(", ")}]`);
        } else {
          qualityScore += Math.ceil(qualityMax * 0.6);
        }

        scores.outputQuality = Math.min(qualityScore, qualityMax);
        details.push(`outputQuality: ${scores.outputQuality}/${qualityMax}`);
      } else {
        details.push(`outputQuality: 0/${maxScores.outputQuality} (no output file)`);
      }
    } catch (e) {
      details.push(`outputQuality: 0/${maxScores.outputQuality} (read error: ${e.message})`);
    }
  } else {
    details.push(`outputQuality: 0/${maxScores.outputQuality} (test failed)`);
  }

  // 3. Tool Usage
  if (testResult.pass) {
    const cp9 = testResult.results.find(r => r.id === 9 && r.detail);
    const toolCalls = cp9 ? parseInt(cp9.detail.replace(/\D/g, "")) : 0;
    if (toolCalls >= 3) {
      scores.toolUsage = maxScores.toolUsage;
    } else if (toolCalls >= 1) {
      scores.toolUsage = Math.ceil(maxScores.toolUsage * 0.6);
    }
    details.push(`toolUsage: ${scores.toolUsage}/${maxScores.toolUsage} (${toolCalls} calls)`);
  } else {
    details.push(`toolUsage: 0/${maxScores.toolUsage} (test failed)`);
  }

  // 4. Completion Speed
  if (testResult.pass) {
    const duration = parseFloat(testResult.duration);
    const isSimple = testCase.expectedPath === "fast-track";
    const speedMax = maxScores.completionSpeed;
    if (isSimple) {
      if (duration < 15) scores.completionSpeed = speedMax;
      else if (duration < 30) scores.completionSpeed = Math.ceil(speedMax * 0.7);
      else if (duration < 60) scores.completionSpeed = Math.ceil(speedMax * 0.3);
    } else {
      if (duration < 45) scores.completionSpeed = speedMax;
      else if (duration < 90) scores.completionSpeed = Math.ceil(speedMax * 0.7);
      else if (duration < 180) scores.completionSpeed = Math.ceil(speedMax * 0.3);
    }
    details.push(`completionSpeed: ${scores.completionSpeed}/${speedMax} (${duration}s)`);
  } else {
    details.push(`completionSpeed: 0/${maxScores.completionSpeed} (test failed)`);
  }

  const total = Object.values(scores).reduce((s, v) => s + v, 0);
  const max = Object.values(maxScores).reduce((s, v) => s + v, 0);

  return { scores, maxScores, total, max, details };
}

export function generateBenchmarkReport(benchResults, totalDuration) {
  const lines = [];
  const now = new Date().toISOString().replace("T", " ").slice(0, 19);

  lines.push("══════════════════════════════════════════════════");
  lines.push(" OPENCLAW BENCHMARK REPORT");
  lines.push(` Run: ${now}  Duration: ${totalDuration}s`);
  lines.push(` Gateway: localhost:${PORT}`);
  lines.push(` Tasks: ${benchResults.length}`);
  lines.push("══════════════════════════════════════════════════");
  lines.push("");

  let grandTotal = 0, grandMax = 0;

  for (const br of benchResults) {
    const { testResult, benchScore, testCase } = br;
    const pathLabel = testResult.isFastTrack === true ? "FAST-TRACK" : "FULL-PATH";
    const result = testResult.pass ? "PASS" : "FAIL";

    lines.push(`── ${testCase.id} "${testCase.message.slice(0, 40)}" ──`);
    lines.push(`Path: ${pathLabel}  Duration: ${testResult.duration}s  Chain: ${result}`);
    lines.push(`Score: ${benchScore.total}/${benchScore.max} (${Math.round(benchScore.total/benchScore.max*100)}%)`);
    lines.push("");

    const passed = testResult.results.filter(r => r.status === "PASS").length;
    const skipped = testResult.results.filter(r => r.status === "SKIP").length;
    const failed = testResult.results.filter(r => r.status === "FAIL").length;
    lines.push(`  Checkpoints: ${passed} PASS, ${skipped} SKIP, ${failed} FAIL`);
    if (!testResult.pass) {
      const diagnosis = summarizeTestDiagnosis(testResult);
      if (diagnosis) {
        lines.push(`  Diagnosis: [${diagnosis.subsystem}] ${diagnosis.conclusion}`);
      }
    }

    for (const d of benchScore.details) {
      lines.push(`  ${d}`);
    }
    lines.push("");

    grandTotal += benchScore.total;
    grandMax += benchScore.max;
  }

  lines.push("══════════════════════════════════════════════════");
  lines.push(` OVERALL: ${grandTotal}/${grandMax} (${Math.round(grandTotal/grandMax*100)}%)`);
  lines.push("");
  lines.push(" SCORES BY CATEGORY:");

  const categories = {};
  for (const br of benchResults) {
    const cat = br.testCase.category || "other";
    if (!categories[cat]) categories[cat] = { total: 0, max: 0, count: 0 };
    categories[cat].total += br.benchScore.total;
    categories[cat].max += br.benchScore.max;
    categories[cat].count++;
  }
  for (const [cat, data] of Object.entries(categories)) {
    lines.push(`   ${cat}: ${data.total}/${data.max} (${Math.round(data.total/data.max*100)}%) [${data.count} tasks]`);
  }

  lines.push("");
  lines.push(" SCORES BY DIMENSION:");
  const dims = { contractFormat: { t: 0, m: 0 }, outputQuality: { t: 0, m: 0 }, toolUsage: { t: 0, m: 0 }, completionSpeed: { t: 0, m: 0 } };
  for (const br of benchResults) {
    for (const dim of Object.keys(dims)) {
      dims[dim].t += br.benchScore.scores[dim] || 0;
      dims[dim].m += br.benchScore.maxScores[dim] || 0;
    }
  }
  for (const [dim, data] of Object.entries(dims)) {
    if (data.m > 0) lines.push(`   ${dim}: ${data.t}/${data.m} (${Math.round(data.t/data.m*100)}%)`);
  }

  lines.push("");
  lines.push(" PERFORMANCE:");
  const passedResults = benchResults.filter(br => br.testResult.pass);
  if (passedResults.length > 0) {
    const avgDuration = (passedResults.reduce((s, br) => s + parseFloat(br.testResult.duration), 0) / passedResults.length).toFixed(1);
    lines.push(`   avg duration: ${avgDuration}s (${passedResults.length} passed tasks)`);
    const toolCounts = passedResults.map(br => {
      const cp9 = br.testResult.results.find(r => r.id === 9 && r.detail);
      return cp9 ? parseInt(cp9.detail.replace(/\D/g, "")) : 0;
    }).filter(n => n > 0);
    if (toolCounts.length > 0) {
      const avgTools = (toolCounts.reduce((s, n) => s + n, 0) / toolCounts.length).toFixed(1);
      lines.push(`   avg tool calls: ${avgTools}/task`);
    }
  }
  lines.push("══════════════════════════════════════════════════");

  return lines.join("\n");
}
