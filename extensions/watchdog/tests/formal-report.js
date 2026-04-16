// tests/formal-report.js — Timeline-based test report generator

// ── Diagnosis ─────────────────────────────────────────────────────────────────

const ISSUE_CATALOG = {
  E_SEND_FAIL:          { subsystem: "bridge-entry",   conclusion: "消息发送失败",           suggestedFix: "检查 bridge agent 配置和 gateway 状态。" },
  E_CONTRACT_MISSING:   { subsystem: "ingress",         conclusion: "消息已发送但合约未创建", suggestedFix: "检查 ingress 分流和合约创建逻辑。" },
  E_TIMEOUT:            { subsystem: "end-to-end",      conclusion: "合约未在超时内到达终态", suggestedFix: "检查事件时间线，定位阻塞阶段。" },
  E_CONTRACT_FAILED:    { subsystem: "execution",       conclusion: "合约执行后状态为 failed", suggestedFix: "检查最后活跃的 agent session 和错误日志。" },
  E_OUTPUT_MISSING:     { subsystem: "output",          conclusion: "合约完成但输出文件不存在", suggestedFix: "检查 output 目录写入和 artifact 提交。" },
  E_OUTPUT_TOO_SMALL:   { subsystem: "output-quality",  conclusion: "输出文件内容过短",       suggestedFix: "检查 worker 产出和最小字数要求。" },
  E_OUTPUT_KEYWORD_MISS:{ subsystem: "output-quality",  conclusion: "输出文件缺少关键内容",   suggestedFix: "检查提示约束和验证关键字。" },
  E_RANDOM_PATH_BLOCKED:{ subsystem: "random-ingress",  conclusion: "随机入口落入 direct session 旁路", suggestedFix: "检查 chosen agent 的正式 shared-contract 外部入口能力。" },
  E_RANDOM_CAPABILITY_BLOCKED:{ subsystem: "random-runtime", conclusion: "该 random family 当前尚未具备正式运行时能力", suggestedFix: "补齐 family 对应的 runtime 对象和控制面，再解除 blocked。" },
};

function buildDiagnosis(result) {
  if (!result || result.pass) return null;
  const errorCode = result.errorCode || "UNKNOWN";
  const meta = ISSUE_CATALOG[errorCode] || {
    subsystem: "unknown",
    conclusion: "测试失败",
    suggestedFix: "检查事件时间线和合约状态。",
  };
  return {
    errorCode,
    subsystem: meta.subsystem,
    conclusion: meta.conclusion,
    suggestedFix: meta.suggestedFix || null,
  };
}

export function summarizeFormalCheckpointDiagnosis(result, diagnose = null) {
  if (typeof diagnose === "function") {
    const custom = diagnose(result);
    if (custom) return custom;
  }
  return buildDiagnosis(result);
}

// ── Timeline formatting ───────────────────────────────────────────────────────

function formatTimelineDetail(entry) {
  const parts = [];
  switch (entry.event) {
    case "contract dispatched":
    case "contract found via poll":
      if (entry.contractId) parts.push(entry.contractId);
      break;
    case "agent session start":
    case "agent session end":
      if (entry.agentId) parts.push(entry.agentId);
      break;
    case "agent tool call":
      if (entry.agentId) parts.push(entry.agentId);
      if (entry.toolCallCount != null) parts.push(`tools=${entry.toolCallCount}`);
      break;
    case "delivery created":
      if (entry.contractId) parts.push(entry.contractId);
      break;
    case "delivery notified":
      if (entry.agentId) parts.push(entry.agentId);
      break;
    default:
      if (entry.agentId) parts.push(entry.agentId);
      if (entry.contractId) parts.push(entry.contractId);
  }
  return parts.join(" ");
}

function renderTimeline(timeline) {
  if (!Array.isArray(timeline) || timeline.length === 0) {
    return ["    (no events recorded)"];
  }

  const baseAt = timeline[0].at;
  const lines = [];

  for (const entry of timeline) {
    const relSec = ((entry.at - baseAt) / 1000).toFixed(1);
    const timeStr = `${relSec}s`.padStart(6);
    const eventStr = String(entry.event || "").padEnd(26);
    const detail = formatTimelineDetail(entry);
    lines.push(`    ${timeStr}  ${eventStr}${detail}`);
  }

  return lines;
}

// ── Result label ──────────────────────────────────────────────────────────────

function resultLabel(result) {
  if (result?.pass) return "PASS";
  if (result?.blocked) return "BLOCKED";
  return "FAIL";
}

// ── Main report generator ─────────────────────────────────────────────────────

export function generateFormalReport({
  suiteType = "single",
  totalDuration,
  gatewayPort = null,
  testResults = [],
} = {}) {
  const lines = [];
  const now = new Date().toISOString().replace("T", " ").slice(0, 16);
  const passed = testResults.filter((r) => r.pass).length;
  const blocked = testResults.filter((r) => r.blocked).length;
  const failed = testResults.filter((r) => !r.pass && !r.blocked).length;

  const durationStr = totalDuration != null ? `${totalDuration}s` : "--";
  const gatewayStr = gatewayPort ? `localhost:${gatewayPort}` : "--";

  lines.push("══════════════════════════════════════════════════");
  lines.push(" OPENCLAW TEST REPORT");
  lines.push(` Run: ${now}  Duration: ${durationStr}`);
  lines.push(` Gateway: ${gatewayStr}`);
  lines.push(` Suite: ${suiteType} | Cases: ${testResults.length}`);
  lines.push("══════════════════════════════════════════════════");
  lines.push("");

  for (const result of testResults) {
    const testCase = result.testCase || {};
    const label = resultLabel(result);
    const duration = result.duration != null ? `${result.duration}s` : "--";
    const msg = testCase.message || testCase.description || testCase.id || "unknown";

    lines.push(`── TEST: "${msg}"  ${label}  ${duration} ──`);

    if (result.contractId) {
      lines.push(`  Contract: ${result.contractId}`);
    }

    lines.push("");
    lines.push("  EVENT TIMELINE:");
    for (const tl of renderTimeline(result.results)) {
      lines.push(tl);
    }
    lines.push("");

    lines.push("  RESULT:");

    if (result.pass) {
      lines.push("    status: completed");
      if (result.outputInfo) {
        const validate = testCase.validate || testCase.validateOutput || null;
        const minBytes = validate?.minBytes;
        const checkMark = minBytes != null ? ` ✓ (min ${minBytes})` : " ✓";
        lines.push(`    output: ${result.outputInfo}${checkMark}`);
      }
    } else {
      const errorCode = result.errorCode || "UNKNOWN";
      const diagnosis = buildDiagnosis(result);
      lines.push(`    status: ${errorCode}`);
      if (result.errorDetail) {
        lines.push(`    detail: ${result.errorDetail}`);
      }
      if (diagnosis) {
        lines.push(`    diagnosis: [${diagnosis.subsystem}] ${diagnosis.conclusion}`);
        lines.push(`    fix: ${diagnosis.suggestedFix}`);
      }
    }

    if (result.randomRuntime) {
      lines.push("");
      lines.push("  RANDOM:");
      lines.push(`    family: ${result.randomRuntime.family || "--"}`);
      lines.push(`    seed: ${result.randomRuntime.seed || "--"}`);
      lines.push(`    chosenAgent: ${result.randomRuntime.chosenAgent || "--"}`);
      lines.push(`    actualPath: ${result.randomRuntime.actualPath || "--"}`);
      if (result.randomRuntime.pathVerdictReason) {
        lines.push(`    reason: ${result.randomRuntime.pathVerdictReason}`);
      }
    }

    lines.push("");
  }

  // ── Summary ──────────────────────────────────────────────────────────────

  const durations = testResults
    .map((r) => parseFloat(r.duration))
    .filter((n) => !isNaN(n));
  const avg = durations.length > 0
    ? (durations.reduce((a, b) => a + b, 0) / durations.length).toFixed(1)
    : "--";

  lines.push("══════════════════════════════════════════════════");
  lines.push(` SUMMARY: ${passed}/${testResults.length} PASSED  ${failed} FAILED  ${blocked} BLOCKED`);
  lines.push(` avg: ${avg}s`);
  lines.push("══════════════════════════════════════════════════");

  return lines.join("\n");
}
