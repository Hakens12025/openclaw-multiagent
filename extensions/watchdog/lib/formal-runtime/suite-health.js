// lib/formal-runtime/suite-health.js — health 套件驱动（旗舰：一次运行、零 LLM、指出哪里坏了）。
//
// TIER-0（health-node：进程内，无 HTTP）先跑——即使 gateway 死了也能给出结论；
// TIER-1（health-gateway：对 live gateway 的 HTTP 检查）后跑，gateway 不可达时整层 blocked。
// 套件只通过 context（check-runner API）追加 CheckResult，绝不自己写报告。

import { runHealthNodeChecks } from "./checks/health-node.js";
import { runHealthGatewayChecks } from "./checks/health-gateway.js";

export async function runHealthSuite(run, context) {
  const { cfg } = await runHealthNodeChecks(run, context);
  await runHealthGatewayChecks(run, context, { cfg });
}
