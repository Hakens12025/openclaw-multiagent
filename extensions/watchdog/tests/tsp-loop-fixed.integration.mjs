// tsp-loop-fixed.integration.mjs — 显式跑的重 LLM 集成测试（*.integration.mjs，不进自动 gate）。
//
// 跑一次真实的 15 城市 TSP 固定 loop（researcher1 -> worker-e -> reviewer1，maxRounds=5），
// 量化评分（代码客观算分），并断言 loop 真的跑起来 + 到点优雅收敛。
//
// 前置：网关在跑（launchctl / start.sh）。运行：
//   node extensions/watchdog/tests/tsp-loop-fixed.integration.mjs
// 可选环境变量：TSP_TIMEOUT_MS（默认 600000）、TSP_MAX_ROUNDS（默认 5）。

import { runTspLoop, TSP_LOOP_AGENTS, TSP_ENTRY_AGENT } from "../lib/formal-runtime/tsp/run-tsp-loop.js";

const maxRounds = Number.parseInt(process.env.TSP_MAX_ROUNDS || "2", 10);
// 2 轮 = 6 个阶段，真 LLM 每个 ~100s，故给 ~15 分钟让它跑完并收敛（而非中途 poll 超时）。
const timeoutMs = Number.parseInt(process.env.TSP_TIMEOUT_MS || "900000", 10);

function line(char = "═") {
  return char.repeat(66);
}

function fmtTour(tour) {
  return Array.isArray(tour) ? tour.join(" -> ") : "(无)";
}

console.log(line());
console.log(" OPENCLAW // TSP 固定 LOOP 集成测试");
console.log(` 拓扑: ${TSP_LOOP_AGENTS.join(" -> ")} -> ${TSP_ENTRY_AGENT}   maxRounds=${maxRounds}`);
console.log(` 超时: ${(timeoutMs / 1000).toFixed(0)}s`);
console.log(line());

const result = await runTspLoop({ maxRounds, timeoutMs, pollIntervalMs: 5000 });

if (!result.ok) {
  console.error(`\n✗ 启动失败于阶段 [${result.phase}]:`);
  console.error(JSON.stringify(result.detail, null, 2));
  process.exit(1);
}

console.log("");
console.log(line("─"));
console.log(` 已知最优 (Held-Karp): ${result.knownOptimal}`);
console.log(` 最近邻基线:           ${result.nearestNeighborBaseline}`);
console.log(` loop 启动:            ${result.started ? "是" : "否"}  (contract=${result.startContractId})`);
console.log(` 收敛:                 ${result.concluded ? "是" : "否(超时)"}  status=${result.finalStatus}`);
console.log(` 终止原因:             ${result.terminalReason}`);
console.log(` 观测轮次:             ${result.roundsObserved}`);
console.log(` 产物巡回数:           ${result.validTourCount} 个有效 / ${result.artifactCount} 个含标记`);
console.log(` 耗时:                 ${(result.durationMs / 1000).toFixed(1)}s`);
console.log(` loop 清理:            ${result.loopCleanup ? "已注销" : "未注销(需手动 graph.loop.delete)"}`);
console.log(line("─"));

if (result.best) {
  const b = result.best;
  console.log("\n★ 最优产出:");
  console.log(`   得分:   ${b.score} / 100`);
  console.log(`   长度:   ${b.length}  (最优比 ${b.ratio}, 最优差距 ${(b.optimalityGap * 100).toFixed(1)}%)`);
  console.log(`   击败最近邻: ${b.beatsNearestNeighbor ? "是" : "否"}`);
  console.log(`   产出者: ${b.agentId}  (contract ${b.contractId})`);
  console.log(`   巡回:   ${fmtTour(b.tour)}`);
} else {
  console.log("\n⚠ 本次运行未产出任何可解析的合法巡回 (TOUR: 标记缺失或格式错误)。");
}

if (result.allTours.length > 1) {
  console.log("\n各产物巡回 (按分数):");
  for (const t of result.allTours) {
    console.log(`   ${String(t.score).padStart(6)}  ${t.agentId.padEnd(12)} len=${t.length} ${t.valid ? "" : "(非法)"}`);
  }
}

console.log(`\n${line()}`);

// ── 断言 ──────────────────────────────────────────────────────────────
const checks = [];
checks.push(["loop 启动", result.started === true]);
checks.push(["loop 收敛(非超时)", result.concluded === true]);
// maxRounds force-conclude（reviewer 从不 conclude 时应由预算治理强制收敛）或 reviewer 主动 conclude 都算健康
checks.push(["产出至少一个合法巡回", result.validTourCount >= 1]);

let allPass = true;
console.log(" 断言:");
for (const [name, pass] of checks) {
  console.log(`   ${pass ? "✔" : "✗"} ${name}`);
  if (!pass) allPass = false;
}
console.log(line());

process.exit(allPass ? 0 : 1);
