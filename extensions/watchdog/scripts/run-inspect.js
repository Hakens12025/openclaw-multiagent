#!/usr/bin/env node
// run-inspect.js — 把一个 run 的两店记录拼成一份可读的全景(只读)
// (harness 判定店已随 harness 全退役删除，v226 / 2026-08-23)
//
//   node scripts/run-inspect.js <runId | contractId | threadId> [--full] [--json]
//
// 拼接逻辑在 lib/archive/run-join.js,本文件只管渲染。
// --full  展开工具调用的入参与结果(默认只给一行摘要)
// --json  输出机器可读的完整结构,给下游程序用

import { joinRunRecords, resolveRunTarget } from "../lib/archive/run-join.js";

const STORE_TAG = { threads: "账", trace: "证" };
const SOURCE_TAG = {
  db: "records.db",
  file: "文件",
  mixed: "records.db+文件",
  none: "无",
};

function clock(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "--:--:--.---";
  const d = new Date(ms);
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

function compact(value, cap = 120) {
  if (value === null || value === undefined) return "";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > cap ? `${oneLine.slice(0, cap - 1)}…` : oneLine;
}

function describe(entry) {
  if (entry.kind === "session_lifecycle") {
    return `— ${entry.label} —`;
  }
  if (entry.kind === "tool_call") {
    const outcome = entry.detail?.outcome;
    const mark = outcome === "ok" ? "" : ` [${outcome ?? "?"}]`;
    return `${entry.label}${mark} ${compact(entry.detail?.args, 70)}`;
  }
  return `${entry.label} ${compact(entry.detail, 80)}`;
}

function renderHeader(joined) {
  const { target, run, stats } = joined;
  const span = stats.fromMs && stats.toMs ? `${((stats.toMs - stats.fromMs) / 1000).toFixed(1)}s` : "未知";
  const agents = joined.participants.map((p) => p.agentId).join(", ") || "无";
  console.log("═".repeat(78));
  console.log(`RUN  ${target.threadId} / ${target.runId}`);
  console.log("═".repeat(78));
  console.log(`触发    ${compact(run?.trigger?.payload) || "未知"}   起 ${clock(stats.fromMs)}   跨度 ${span}`);
  console.log(`收口    ${run?.closed ? `已关账 · ${compact(run?.closedSummary?.payload)}` : "未关账"}`);
  console.log(`参与者  ${agents}`);
  console.log(
    `体量    事件 ${stats.events} · 合约 ${stats.contracts}/${stats.contractIds} 份正本在场`
    + ` · 工具调用 ${stats.toolCalls}(${stats.traceSessions} 个会话)`,
  );
  // 双写验证期观测:两路各从哪读(DB 影子还是文件真值)。读面全切后随垫片同删。
  const src = joined.recordSource || {};
  console.log(
    `数据源  事件账 ${SOURCE_TAG[src.events] ?? "?"} · 证据账 ${SOURCE_TAG[src.traces] ?? "?"}`,
  );
}

function renderTimeline(joined, { full }) {
  console.log(`\n${"─".repeat(78)}`);
  console.log("时间线  跨店按 ts 近似对齐;店内权威序见 orderKey,真因果看 causeRefs");
  console.log("─".repeat(78));
  for (const entry of joined.timeline) {
    const who = String(entry.agentId ?? "").padEnd(10);
    console.log(`${clock(entry.ts)}  [${STORE_TAG[entry.store]}] ${who} ${describe(entry)}`);
    if (entry.causeRefs?.length) {
      console.log(`${" ".repeat(12)}   ↳ 因果 ${compact(entry.causeRefs, 90)}`);
    }
    if (full && entry.kind === "tool_call") {
      console.log(`${" ".repeat(12)}   ↳ 入参 ${compact(entry.detail?.args, 400)}`);
      console.log(`${" ".repeat(12)}   ↳ 结果 ${compact(entry.detail?.result, 400)}`);
    }
  }
}

function renderParticipants(joined) {
  console.log(`\n${"─".repeat(78)}`);
  console.log("参与者与交付物");
  console.log("─".repeat(78));
  for (const p of joined.participants) {
    console.log(`\n  ${p.agentId}`);
    for (const inbox of p.inboxes) {
      const task = compact(inbox.contract?.task, 60);
      console.log(`    收  ${inbox.contractId}${task ? `  任务「${task}」` : ""}`);
      const pkgs = inbox.contract?.upstreamPackages;
      if (Array.isArray(pkgs) && pkgs.length > 0) {
        for (const pkg of pkgs) {
          console.log(`        上游包 ${pkg.producer}: ${(pkg.files || []).join(", ") || "空"}`);
        }
      }
    }
    for (const outbox of p.outboxes) {
      const seal = outbox.sealed
        ? `已封包 primary=${outbox.primary ?? "无"} status=${outbox.declaredStatus ?? "未声明"}`
        : "未封包";
      console.log(`    交  ${outbox.contractId}  ${seal}`);
      console.log(`        文件 ${outbox.files.join(", ") || "空"}`);
    }
    const extras = [
      p.sessionTranscripts.length ? `会话转录 ${p.sessionTranscripts.length}` : null,
      p.turnProjections.length ? `轮次投影 ${p.turnProjections.length}` : null,
      p.deliveries.length ? `投递留档 ${p.deliveries.length}` : null,
    ].filter(Boolean);
    if (extras.length) console.log(`    留档 ${extras.join(" · ")}`);
  }
}

function renderGaps(joined) {
  console.log(`\n${"─".repeat(78)}`);
  if (joined.gaps.length === 0) {
    console.log("缺口    无 —— 三个店在这个 run 上是齐的");
    return;
  }
  console.log(`缺口    ${joined.gaps.length} 处(拼不上的地方一律点名,不留白)`);
  console.log("─".repeat(78));
  for (const gap of joined.gaps) {
    const ids = gap.ids?.length ? `  ${gap.ids.join(", ")}` : "";
    console.log(`  [${STORE_TAG[gap.store] ?? gap.store}] ${gap.what} —— ${gap.reason}${ids}`);
  }
}

function main() {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith("--")));
  const id = args.find((a) => !a.startsWith("--"));

  if (!id) {
    console.error("用法: node scripts/run-inspect.js <runId | contractId | threadId> [--full] [--json]");
    process.exit(2);
  }

  const target = resolveRunTarget(id);
  if (!target) {
    console.error(`定位不到:${id}(试过 contractId 索引、runId 与 threadId 目录)`);
    process.exit(1);
  }

  const joined = joinRunRecords(target);

  if (flags.has("--json")) {
    console.log(JSON.stringify(joined, null, 2));
    return;
  }

  renderHeader(joined);
  renderTimeline(joined, { full: flags.has("--full") });
  renderParticipants(joined);
  renderGaps(joined);
  console.log("");
}

main();
