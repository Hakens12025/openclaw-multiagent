#!/usr/bin/env node
// scripts/migrate-soul-identity.js — SOUL/IDENTITY 六层模型迁移闸
//
// 把"系统烘焙进 SOUL.md 的 role persona"搬到正确的载体上：
//   ④role 层 → IDENTITY.md（系统托管，带 MANAGED_BOOTSTRAP_MARKER）
//   ⑤SOUL   → 纯用户人格（用户拥有，无 marker，重置为占位）
//
// 真值源 = openclaw.json 的 agents.list（每个 agent 的 role 与 workspace 都在这里），
// 不靠目录 glob——~/.openclaw/agents/<id>/ 是 session 目录、不含 SOUL.md，真正的工作区
// 在 agents.list[].workspace（缺省 workspaces/<id>）。这与 syncAllRuntimeWorkspaceGuidance
// 的迭代源完全一致。
//
// 对每个 agent：
//   (1) 若 SOUL.md 带 managed marker（= 旧的 role 烘焙版，系统生成）：
//         - IDENTITY.md ← MANAGED_BOOTSTRAP_MARKER + renderRolePersonaBlock(role)（托管）
//         - SOUL.md     ← 不带 marker 的用户占位（系统此后永不重写）
//   (2) 若 SOUL.md 无 marker（用户已接管）或缺失：跳过，不动用户文件。
//
// 用法：
//   node scripts/migrate-soul-identity.js              # 默认 dry-run（只打印，不写盘）
//   node scripts/migrate-soul-identity.js --dry-run    # 同上（显式）
//   node scripts/migrate-soul-identity.js --apply      # 真正写盘

import { readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import process from "node:process";

import {
  MANAGED_BOOTSTRAP_MARKER,
  normalizeManagedDocContent,
} from "../extensions/watchdog/lib/managed-doc-markers.js";
import { renderRolePersonaBlock } from "../extensions/watchdog/lib/role-spec-registry.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OPENCLAW_JSON = join(ROOT, "openclaw.json");
const HOME = homedir();

const apply = process.argv.slice(2).includes("--apply");

// ── 载体内容构造（与 workspace-guidance-writer.js 的 build* 完全同形）─────────────
// ④role 托管 IDENTITY：marker + persona block；persona 为空时退化为只含标题的托管占位。
function buildManagedIdentityDoc(agentId, role) {
  const personaBlock = renderRolePersonaBlock(role);
  const body = personaBlock ? `# ${agentId}\n\n${personaBlock}\n` : `# ${agentId}\n`;
  return `${MANAGED_BOOTSTRAP_MARKER}\n${body}`;
}

// ⑤SOUL 用户占位：无 marker，用户拥有，系统此后不再触碰。
function buildUserSoulPlaceholder(agentId) {
  return `# ${agentId}\n\n<Write this agent's custom persona here — you own this file and the platform leaves it untouched.>\n`;
}

// ── 工作区/角色解析（对齐 openclaw.json 真值与 agent-binding 的读法）────────────
function expandHome(filePath) {
  return typeof filePath === "string" && filePath.trim()
    ? filePath.trim().replace(/^~(?=\/|$)/, HOME)
    : null;
}

function resolveWorkspace(agentId, agentConfig) {
  const configured = expandHome(agentConfig?.workspace)
    || expandHome(agentConfig?.binding?.workspace?.configured);
  if (configured) {
    return isAbsolute(configured) ? configured : resolve(ROOT, configured);
  }
  return join(HOME, ".openclaw", "workspaces", agentId);
}

function resolveRole(agentConfig) {
  const explicit = (
    (typeof agentConfig?.role === "string" && agentConfig.role)
    || (typeof agentConfig?.binding?.roleRef === "string" && agentConfig.binding.roleRef)
    || ""
  ).trim().toLowerCase();
  // normalizeAgentRole 的等价：缺省落 "agent"（通用平台节点）。
  return explicit || "agent";
}

function readOrNull(filePath) {
  try {
    return normalizeManagedDocContent(readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function isFile(filePath) {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

const toRel = (filePath) => filePath.replace(`${HOME}/`, "~/");
const oneLine = (text) => String(text).replace(/\n/g, "\\n");

// ── 主流程 ─────────────────────────────────────────────────────────────────────
let config;
try {
  config = JSON.parse(readFileSync(OPENCLAW_JSON, "utf8"));
} catch (error) {
  console.error(`✗ 读取 openclaw.json 失败：${error.message}`);
  process.exit(1);
}

const agents = Array.isArray(config?.agents?.list) ? config.agents.list : [];
console.log(`模式：${apply ? "APPLY（真改写盘）" : "DRY-RUN（只打印，不写盘）"}`);
console.log(`真值源：${toRel(OPENCLAW_JSON)}    agents.list 共 ${agents.length} 个 agent\n`);

let migrated = 0;
let skippedNoMarker = 0;
let skippedMissing = 0;
const planned = [];

for (const agentConfig of agents) {
  const agentId = typeof agentConfig?.id === "string" ? agentConfig.id.trim() : "";
  if (!agentId) continue;

  const role = resolveRole(agentConfig);
  const workspaceDir = resolveWorkspace(agentId, agentConfig);
  const soulPath = join(workspaceDir, "SOUL.md");
  const identityPath = join(workspaceDir, "IDENTITY.md");
  const soulContent = readOrNull(soulPath);

  console.log(`── ${agentId}  (role=${role})`);
  console.log(`   workspace: ${toRel(workspaceDir)}`);

  // 决策：只有"带 marker 的 SOUL"才是系统烘焙版、才迁移。
  if (soulContent === null) {
    console.log(`   SOUL.md  : 缺失 → 跳过（无系统烘焙内容可迁移）\n`);
    skippedMissing += 1;
    continue;
  }
  if (!soulContent.includes(MANAGED_BOOTSTRAP_MARKER)) {
    console.log(`   SOUL.md  : 无 marker（用户已接管）→ 跳过，不动用户文件\n`);
    skippedNoMarker += 1;
    continue;
  }

  // 迁移目标内容。
  const newIdentity = buildManagedIdentityDoc(agentId, role);
  const newSoul = buildUserSoulPlaceholder(agentId);
  const persona = renderRolePersonaBlock(role);

  const identityBefore = readOrNull(identityPath);
  const identityExists = isFile(identityPath);
  const identityWasManaged = identityBefore !== null
    && identityBefore.includes(MANAGED_BOOTSTRAP_MARKER);

  console.log(`   ▶ SOUL.md  : managed（系统烘焙 role 版，${Buffer.byteLength(soulContent)} bytes）`);
  console.log(`              → 重置为用户占位（无 marker，${Buffer.byteLength(newSoul)} bytes）`);
  console.log(`                内容: "${oneLine(newSoul)}"`);
  console.log(
    `   ▶ IDENTITY.md: ${identityExists
      ? (identityWasManaged ? "已存在(托管,将覆盖)" : "已存在(无 marker!,将覆盖)")
      : "不存在(将新建)"} → 写 role persona（托管，${Buffer.byteLength(newIdentity)} bytes）`,
  );
  console.log(
    `                persona 段: ${persona
      ? `"## 角色 ..." 共 ${persona.split("\n").length} 行`
      : "（空 → 仅写 # 标题托管占位）"}`,
  );
  console.log("");

  planned.push({ agentId, soulPath, identityPath, newSoul, newIdentity });
  migrated += 1;
}

console.log("──────────────────────────────────────────────────────────────");
console.log("汇总：");
console.log(`  将迁移          : ${migrated} 个 agent`);
console.log(`  跳过(SOUL 无 marker,用户接管): ${skippedNoMarker} 个`);
console.log(`  跳过(SOUL 缺失) : ${skippedMissing} 个`);
console.log(`  agents.list 总数: ${agents.length}`);

if (!apply) {
  console.log("\n（dry-run：未写任何文件。加 --apply 真正执行迁移。）");
  process.exit(0);
}

let wrote = 0;
for (const item of planned) {
  // 先写 IDENTITY（落地 ④role），再重置 SOUL（清掉 ⑤旧烘焙）——失败不至于丢掉 persona。
  writeFileSync(item.identityPath, item.newIdentity, "utf8");
  writeFileSync(item.soulPath, item.newSoul, "utf8");
  wrote += 1;
  console.log(`  ✓ ${item.agentId}: IDENTITY.md 写入托管 persona，SOUL.md 重置为用户占位`);
}
console.log(`\n✓ 迁移完成：${wrote} 个 agent。`);
process.exit(0);
