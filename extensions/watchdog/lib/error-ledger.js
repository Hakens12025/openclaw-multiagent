// lib/error-ledger.js — Global error pattern ledger + skill file auto-generation
//
// When any agent crashes, the error pattern is recorded here.
// The ledger auto-generates skills/error-avoidance/SKILL.md so that
// ALL agents learn from every crash across the entire system.

import { readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { OC, atomicWriteFile, withLock } from "./state.js";

const DATA_DIR = join(OC, "extensions", "watchdog", "data");
const LEDGER_FILE = join(DATA_DIR, "error-ledger.json");
const SKILL_DIR = join(OC, "skills", "error-avoidance");
const SKILL_FILE = join(SKILL_DIR, "SKILL.md");
const MAX_ENTRIES = 15;
const ENTRY_EXPIRY_MS = 7 * 24 * 60 * 60_000; // 7 days
const ERROR_LEDGER_LOCK = "store:error-ledger";

// ── Error classification ────────────────────────────────────────────────────

const ERROR_TYPES = [
  { type: "context_overflow", test: /context.*(length|limit|exceeded|overflow)|token.*(limit|exceeded)/i },
  { type: "timeout",         test: /timeout|timed?\s*out/i },
  { type: "rate_limit",      test: /rate.*(limit|exceeded)|429|too many requests/i },
  { type: "permission",      test: /permission|denied|forbidden|403/i },
  { type: "file_not_found",  test: /ENOENT|not found|no such file/i },
  { type: "disk_full",       test: /ENOSPC|disk.*full|no space/i },
  { type: "connection",      test: /ECONNREFUSED|ECONNRESET|ETIMEDOUT|fetch failed|network/i },
];

const ERROR_LABELS = {
  context_overflow: "上下文溢出",
  timeout: "执行超时",
  rate_limit: "API 限流",
  permission: "权限错误",
  file_not_found: "路径不存在",
  disk_full: "磁盘空间不足",
  connection: "网络连接失败",
  unknown: "其他错误",
};

const ERROR_GUIDANCE = {
  context_overflow: [
    "避免 read 大文件，用 grep/glob 精确搜索替代全文阅读",
    "分步执行，先完成最关键的输出",
    "单次操作不要读取超过 3 个大文件",
  ],
  timeout: [
    "先输出最关键的结果，避免长时间搜索",
    "复杂任务拆成小步骤分别完成",
  ],
  rate_limit: [
    "减少 web_search/web_fetch 频率，合并相似查询",
    "优先使用本地工具（read/grep/glob）",
  ],
  permission: [
    "只访问自己 workspace 内的文件（inbox/、outbox/）",
    "不要读取 openclaw.json 或其他 agent 的 workspace",
  ],
  file_not_found: [
    "先用 glob 确认目标路径存在，不要硬编码猜测",
    "检查 contract 中指定的 output 路径是否正确",
  ],
  disk_full: [
    "清理 output/ 目录中不需要的临时文件",
  ],
  connection: [
    "如果 web_search 失败，改用本地文件和已有数据完成任务",
    "不要反复重试同一个失败的网络请求",
  ],
  unknown: [
    "检查上次方法是否可行，考虑简化或换一种方式",
  ],
};

function classifyErrorType(reason) {
  const text = String(reason);
  for (const { type, test } of ERROR_TYPES) {
    if (test.test(text)) return type;
  }
  return "unknown";
}

// ── Ledger persistence ──────────────────────────────────────────────────────

async function loadLedger() {
  try {
    const raw = await readFile(LEDGER_FILE, "utf8");
    return JSON.parse(raw);
  } catch {
    return { patterns: [], version: 1 };
  }
}

async function saveLedger(ledger) {
  await mkdir(DATA_DIR, { recursive: true });
  await atomicWriteFile(LEDGER_FILE, JSON.stringify(ledger, null, 2));
}

// ── Core: record + regenerate ───────────────────────────────────────────────

export async function recordErrorPattern({ error, agentId, trackingState, logger }) {
  const reason = String(error || "unknown");
  const errorType = classifyErrorType(reason);
  const task = trackingState?.contract?.task?.slice(0, 80) || "";
  const toolCalls = (trackingState?.toolCalls || [])
    .slice(-5)
    .map(tc => tc.label || tc.tool);
  return withLock(ERROR_LEDGER_LOCK, async () => {
    const ledger = await loadLedger();
    const now = Date.now();

    // Expire old entries
    ledger.patterns = ledger.patterns.filter(p => (now - (p.lastSeen || 0)) < ENTRY_EXPIRY_MS);

    // Dedup: merge into existing entry for same error type
    const existing = ledger.patterns.find(p => p.errorType === errorType);
    if (existing) {
      existing.count += 1;
      existing.lastSeen = now;
      existing.lastAgent = agentId;
      existing.lastTask = task;
      if (toolCalls.length > 0) existing.lastTools = toolCalls;
    } else {
      ledger.patterns.push({
        errorType,
        count: 1,
        firstSeen: now,
        lastSeen: now,
        lastAgent: agentId,
        lastTask: task,
        lastTools: toolCalls,
      });
    }

    // Sort by frequency, cap entries
    ledger.patterns.sort((a, b) => b.count - a.count);
    if (ledger.patterns.length > MAX_ENTRIES) {
      ledger.patterns = ledger.patterns.slice(0, MAX_ENTRIES);
    }

    await saveLedger(ledger);
    await regenerateSkillFile(ledger, logger);

    logger?.info?.(
      `[error-ledger] recorded ${errorType} from ${agentId} (total: ${existing?.count || 1})`,
    );

    return { errorType, count: existing?.count || 1 };
  });
}

// ── Skill file generation ───────────────────────────────────────────────────

async function regenerateSkillFile(ledger, logger) {
  const patterns = ledger.patterns;
  if (patterns.length === 0) return;

  const lines = [
    "# 错误回避知识库",
    "",
    "以下是全系统历史执行中积累的经验教训。所有 agent 共享此知识。",
    "执行任务时请主动规避这些已知问题。",
    "",
  ];

  for (const p of patterns) {
    const label = ERROR_LABELS[p.errorType] || p.errorType;
    const guidance = ERROR_GUIDANCE[p.errorType] || ERROR_GUIDANCE.unknown;
    lines.push(`## ${label}（已发生 ${p.count} 次）`);
    lines.push("");
    for (const g of guidance) {
      lines.push(`- ${g}`);
    }
    if (p.lastTools && p.lastTools.length > 0) {
      lines.push(`- 最近触发路径: ${p.lastTools.join(" → ")}`);
    }
    lines.push("");
  }

  try {
    await mkdir(SKILL_DIR, { recursive: true });
    await atomicWriteFile(SKILL_FILE, lines.join("\n"));
    logger?.info?.(`[error-ledger] regenerated error-avoidance skill (${patterns.length} patterns)`);
  } catch (e) {
    logger?.warn?.(`[error-ledger] failed to regenerate skill: ${e.message}`);
  }
}
