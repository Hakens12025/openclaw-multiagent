#!/usr/bin/env node
// public-sync.js — 公开仓同步(带密钥扫描门)。2026-08-27 立,替代手动 rsync+人肉脱敏。
//
// 动机(§13 同族):rsync 会覆盖上次的脱敏成果——真 token/真 IP 曾被同步带回公开树,
// 靠临场扫描抓回。结构修法=同步与脱敏与门禁一体化:扫描不过=拒绝走到 commit。
//
// 流程: ①rsync 8 目录(--delete,排 node_modules/research-lab/test-reports)
//       ②收集真密钥值(openclaw.json 密钥字段 + profiles/default.env 的远程主机)
//       ③精确值自动脱敏 → REDACTED_FOR_PUBLIC(与历史公开版占位符一致)
//       ④硬门A:精确真值复扫,任何命中 → exit 2
//       ⑤审计门B:通用密钥形(pattern)扫描,新增命中(不在 baseline)→ exit 3
//       ⑥打印 diffstat 与后续命令;带 --commit "msg" [--tag vN] 则代为 commit
// 用法: node ~/.openclaw/scripts/public-sync.js [--commit "msg"] [--tag vN-stable]
// 退出码: 0=通过 2=真值泄漏(绝不放行) 3=pattern 新增命中待人审 4=环境错误
// baseline: scripts/public-sync-baseline.txt(pattern 命中的已验假值清单,file:pattern 每行)

import { execFileSync, execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const OC = join(homedir(), ".openclaw");
const STAGING = join(homedir(), "openclaw-public-export");
const PLACEHOLDER = "REDACTED_FOR_PUBLIC";
const BASELINE = join(OC, "scripts", "public-sync-baseline.txt");
const SYNC_DIRS = [
  "extensions/watchdog", "extensions/qqbot",
  "skills", "wiki", "docs", "scripts", "profiles",
  ".github", // CI 矩阵属产品面(watchdog 离线单测),公开仓要带;门A/门B 照常全扫 staging 含此目录
];
// 顶层单文件同步清单(SYNC_DIRS 只覆盖目录):openclawctl.js 是产品运维唯一入口,
// 公开 README/SETUP 全面指向它,不同步则 fresh clone 直接断头;三个 bash 转发壳
// 同步走真值版(公开仓滞留旧 77/193 行版会绊 compat-shell 守卫,CI 第二轮实证)。
const SYNC_FILES = ["openclawctl.js", "start.sh", "setup.sh", "clean.sh"];
// .replay-cache=RAG 测试重放缓存(内嵌备忘录私有语料);__pycache__=二进制产物。都不公开。
const EXCLUDES = ["node_modules", "research-lab", "test-reports", ".DS_Store", ".replay-cache", "__pycache__"];

function die(code, msg) { console.error(msg); process.exit(code); }

if (!existsSync(STAGING) || !existsSync(join(STAGING, ".git"))) {
  die(4, `staging 缺席或非 git 仓: ${STAGING}`);
}

// ── ① rsync ────────────────────────────────────────────────────────────────
const exArgs = EXCLUDES.flatMap((e) => ["--exclude", e]);
for (const dir of SYNC_DIRS) {
  // --delete-excluded:排除物若已躺在 staging(历史手动 rsync 带进去的)也一并清走
  execFileSync("rsync", ["-a", "--delete", "--delete-excluded", ...exArgs, `${OC}/${dir}/`, `${STAGING}/${dir}/`]);
  console.log(`✓ rsync ${dir}`);
}
for (const file of SYNC_FILES) {
  execFileSync("rsync", ["-a", `${OC}/${file}`, `${STAGING}/${file}`]);
  console.log(`✓ rsync ${file}`);
}

// ── ② 真密钥值收集(属主=live 配置;字段级,不做全字符串猜测) ────────────────
function collectRealSecrets() {
  const out = new Map(); // value → label
  const add = (v, label) => {
    if (typeof v === "string" && v.trim().length >= 12) out.set(v.trim(), label);
  };
  const cfg = JSON.parse(readFileSync(join(OC, "openclaw.json"), "utf8"));
  add(cfg?.gateway?.auth?.token, "gateway.auth.token");
  add(cfg?.gateway?.hooksToken, "gateway.hooksToken");
  add(cfg?.hooks?.token, "hooks.token");
  for (const [name, p] of Object.entries(cfg?.models?.providers || {})) add(p?.apiKey, `${name}.apiKey`);
  for (const [ch, cc] of Object.entries(cfg?.channels || {})) {
    if (cc && typeof cc === "object") {
      for (const [k, v] of Object.entries(cc)) if (/token|secret|key|appid/i.test(k)) add(v, `${ch}.${k}`);
    }
  }
  // SSH 远程主机(profiles/default.env,历史占位符同款处理)
  try {
    const env = readFileSync(join(OC, "profiles", "default.env"), "utf8");
    const m = env.match(/OPENCLAW_SSH_REMOTE_HOST=([^\s#]+)/);
    if (m && m[1] !== PLACEHOLDER) out.set(m[1], "ssh.remoteHost");
  } catch { /* profiles 缺席可容 */ }
  return out;
}
const secrets = collectRealSecrets();
console.log(`真密钥字段: ${secrets.size} 个`);

// ── ③ 精确值自动脱敏 + ④ 硬门A ────────────────────────────────────────────
function grepFiles(pattern, fixed = true) {
  try {
    const args = ["-rl", ...(fixed ? ["-F"] : ["-E"]), pattern, ".", "--exclude-dir=.git"];
    return execFileSync("grep", args, { cwd: STAGING }).toString().trim().split("\n").filter(Boolean);
  } catch { return []; } // 无命中 grep exit 1
}
let scrubbed = 0;
for (const [value, label] of secrets) {
  for (const file of grepFiles(value)) {
    const p = join(STAGING, file);
    writeFileSync(p, readFileSync(p, "utf8").split(value).join(PLACEHOLDER));
    console.log(`  脱敏 ${label} @ ${file}`);
    scrubbed += 1;
  }
}
for (const [value, label] of secrets) {
  const left = grepFiles(value);
  if (left.length) die(2, `❌ 硬门A:真值 ${label} 脱敏后仍在 ${left.join(", ")} —— 拒绝放行`);
}
console.log(`硬门A ✅ 真值零泄漏(自动脱敏 ${scrubbed} 处)`);

// ── ⑤ 审计门B:通用密钥形 pattern,新增命中比对 baseline ─────────────────────
// 安全门纪律:grep 退出码只认 0(命中)/1(零命中);其它一律 fail-loud(exit 4)——
// pattern 写错被吞成"零命中放行"= 门自己 fail-open,首跑实测踩过(macOS 无 -P)。
function grepE(re) {
  try {
    return execFileSync("grep", ["-rlE", re, ".", "--exclude-dir=.git"], { cwd: STAGING })
      .toString().trim().split("\n").filter(Boolean);
  } catch (e) {
    if (e.status === 1) return []; // 零命中
    die(4, `❌ 审计门B 自身故障(grep exit ${e.status}): ${re} —— 门坏了不放行`);
  }
}
const PATTERNS = [
  ["sk-key", "sk-[A-Za-z0-9]{24,}"],
  ["glm-key-shape", "[0-9a-f]{32}\\.[A-Za-z0-9]{16}"],
  ["hex48-token", "[0-9a-f]{48}"],
];
// baseline 自身随 scripts/ 同步进 staging,其记录行必然自绊 pattern → 仅门B豁免;硬门A 照扫它。
const SCAN_EXEMPT = new Set(["./scripts/public-sync-baseline.txt"]);
const hits = [];
for (const [name, re] of PATTERNS) {
  for (const f of grepE(re)) if (!SCAN_EXEMPT.has(f)) hits.push(`${f}:${name}`);
}
// 公网 IPv4:macOS grep 无 PCRE 负向断言 → 宽匹配后 JS 过滤保留段/环回/版本号形。
{
  const PRIVATE = /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.|198\.18\.|255\.|169\.254\.)/;
  for (const f of grepE("[0-9]{1,3}\\.[0-9]{1,3}\\.[0-9]{1,3}\\.[0-9]{1,3}")) {
    if (SCAN_EXEMPT.has(f)) continue;
    let content = "";
    try { content = readFileSync(join(STAGING, f), "utf8"); } catch { continue; }
    const ips = content.match(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g) || [];
    const pub = ips.filter((ip) => !PRIVATE.test(ip) && ip.split(".").every((o) => Number(o) <= 255)
      && !/^(\d)\.\d{1,2}\.\d{1,2}\.\d{1,2}$/.test(ip)); // 首段个位数多为版本号形,单独人审过再收紧
    if (pub.length) hits.push(`${f}:public-ipv4(${[...new Set(pub)].slice(0, 3).join(",")})`);
  }
}
const baseline = new Set(
  existsSync(BASELINE) ? readFileSync(BASELINE, "utf8").split("\n").map((l) => l.trim()).filter(Boolean) : [],
);
const fresh = hits.filter((h) => !baseline.has(h));
if (fresh.length) {
  console.error("❌ 审计门B:pattern 新增命中(不在 baseline),人工确认为假值后加入 baseline 再跑:");
  for (const h of fresh) console.error(`   ${h}`);
  die(3, `   baseline: ${BASELINE}`);
}
console.log(`审计门B ✅ pattern 命中 ${hits.length} 处全部在 baseline(已验假值)`);

// ── ⑥ 收尾 ────────────────────────────────────────────────────────────────
const stat = execSync("git status --short | wc -l", { cwd: STAGING }).toString().trim();
console.log(`变更文件: ${stat}`);
const ci = process.argv.indexOf("--commit");
if (ci > -1 && process.argv[ci + 1]) {
  execFileSync("git", ["add", "-A"], { cwd: STAGING });
  execFileSync("git", ["commit", "-q", "-m", process.argv[ci + 1]], { cwd: STAGING });
  const ti = process.argv.indexOf("--tag");
  if (ti > -1 && process.argv[ti + 1]) execFileSync("git", ["tag", process.argv[ti + 1]], { cwd: STAGING });
  console.log("已 commit" + (ti > -1 ? ` + tag ${process.argv[ti + 1]}` : "") + ";push 请手动: git -c http.version=HTTP/1.1 push origin HEAD --tags");
} else {
  console.log(`门全过。commit 请: node ~/.openclaw/scripts/public-sync.js --commit "msg" [--tag vN-stable]`);
}
