#!/usr/bin/env node
// scripts/check-doc-paths.js — 防文档→代码路径漂移闸
//
// 扫描所有 Markdown 里对 watchdog 源码路径的引用(lib/… hooks/… routes/…
// tests/… dashboard-*.js)，校验被引用文件是否真实存在。
// 活文档(非归档)出现失效引用 → 退出码 1，可挂 pre-commit / CI。
// 历史归档计划/规格(docs/superpowers/plans|specs)里的引用可能指向已删除文件，
// 默认只告警不失败；用 --all 把归档漂移也打印出来。
//
// 用法:
//   node scripts/check-doc-paths.js          # 活文档校验(CI 模式)
//   node scripts/check-doc-paths.js --all     # 含归档漂移明细

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WATCHDOG = join(ROOT, "extensions", "watchdog");

const includeArchival = process.argv.slice(2).includes("--all");

// 归档目录：历史计划/规格，引用的文件可能已被重构删除，属正常历史记录。
const ARCHIVAL_PREFIXES = [
  "docs/superpowers/plans/",
  "docs/superpowers/specs/",
  "extensions/watchdog/docs/superpowers/plans/",
  "extensions/watchdog/docs/superpowers/specs/",
];
// 跳过运行态/非源码目录(对齐 .gitignore)——这些含 agent 生成的临时 .md，不是文档。
const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build",
  "workspaces", "workspace", "workspace-main", "subagents", "agents",
  "research-lab", "delivery-queue", "canvas", "browser", "cron",
  "output", "completions", "memory", "logs", "test-reports", "benchmark-results",
  "control-plane", "certs", "credentials", "identity", "devices",
  "backup", "use guide", "openclaw_use_guide",
]);

// watchdog 相对源码路径(可选带 extensions/watchdog/ 或绝对前缀)。
const PATH_RE =
  /(?:extensions\/watchdog\/)?((?:lib|hooks|routes|tests|domains)\/[\w./-]+\.js|dashboard-[\w-]+\.js)/g;

function walkMarkdown(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkMarkdown(full, acc);
    else if (entry.name.endsWith(".md")) acc.push(full);
  }
  return acc;
}

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

const toRel = (path) => path.replace(`${ROOT}/`, "");
// 归档 = 历史计划/规格目录 或 日期戳审计快照(audit-YYYY-MM-DD/…)。
const isArchival = (relPath) =>
  ARCHIVAL_PREFIXES.some((p) => relPath.startsWith(p)) || /^audit-\d{4}-/.test(relPath);

// 占位符/模板路径(文档示例用，非真实引用)，不计漂移。
const isPlaceholder = (candidate) =>
  /(?:^|\/)(?:xxx+|foo|bar|baz|example|placeholder|your-?\w*)\.js$/i.test(candidate) ||
  /[<>*]/.test(candidate);

let liveDrift = 0;
let archivalDrift = 0;
const findings = [];

for (const mdPath of walkMarkdown(ROOT)) {
  const relMd = toRel(mdPath);
  const archival = isArchival(relMd);
  const hits = [];
  let content;
  try {
    content = readFileSync(mdPath, "utf8");
  } catch {
    continue; // 运行态文件可能在 readdir 与 read 之间被清理，跳过即可
  }
  content
    .split("\n")
    .forEach((line, index) => {
      let match;
      PATH_RE.lastIndex = 0;
      while ((match = PATH_RE.exec(line))) {
        const candidate = match[1];
        if (isPlaceholder(candidate)) continue;
        if (isFile(join(WATCHDOG, candidate))) continue;
        hits.push({ line: index + 1, path: candidate });
      }
    });
  if (hits.length === 0) continue;
  if (archival) archivalDrift += hits.length;
  else liveDrift += hits.length;
  findings.push({ relMd, archival, hits });
}

for (const finding of findings) {
  if (finding.archival && !includeArchival) continue;
  console.log(`${finding.archival ? "  [archival]" : "  [LIVE]"} ${finding.relMd}`);
  for (const hit of finding.hits) {
    console.log(`    L${hit.line}: ${hit.path}  → 文件不存在`);
  }
}

console.log("");
console.log(
  `live-doc drift: ${liveDrift}   archival drift: ${archivalDrift}` +
    (includeArchival ? "" : "  (--all 看归档明细)"),
);

if (liveDrift > 0) {
  console.log("✗ 活文档存在失效代码路径引用，修正后再提交。");
  process.exit(1);
}
console.log("✓ 活文档代码路径全部有效。");
process.exit(0);
