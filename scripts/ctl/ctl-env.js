// ctl-env.js — openclawctl 的环境与配置解析(纯逻辑,零依赖,跨平台)。
// 产品化批1(2026-08-28):运维层 Node 化的地基——路径解析/配置读取/profile 解析/env 组装。
// 服务单元(launchd/systemd/schtasks)由宿主 CLI `openclaw gateway install` 生成,
// 本层只负责编排与 env,平台差异不下渗到调用方。

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

// 仓库根 = 本文件的上上级(scripts/ctl/ → 根)。以自身定位而非硬编码 ~/.openclaw,
// 克隆到任意目录 ctl 都能自洽;与宿主期望位置不一致时由 doctor 提示而不是静默错位。
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const EXPECTED_ROOT = join(homedir(), ".openclaw");

export const PATHS = {
  config: join(ROOT, "openclaw.json"),
  configExample: join(ROOT, "openclaw.example.json"),
  profile: join(ROOT, "profiles", "default.env"),
  logsDir: join(ROOT, "logs"),
  gatewayLog: join(ROOT, "logs", "gateway.log"),
  gatewayErrLog: join(ROOT, "logs", "gateway.err.log"),
  caBundle: join(ROOT, "certs", "system-roots.pem"),
  caRefreshScript: join(ROOT, "scripts", "refresh-system-ca-bundle.sh"),
  workspacesDir: join(ROOT, "workspaces"),
  qqbotDir: join(ROOT, "extensions", "qqbot"),
};

export const DEFAULT_PORT = 18789;

// LLM 出站走代理时,本地回环与直连厂商必须豁免——不设 NO_PROXY 会把 localhost
// embed(ollama)塞进隧道(2026-08-07 实证)。此清单是安全地板,与 profile 的合并取并集。
export const NO_PROXY_FLOOR = ["localhost", "127.0.0.1", "::1"];

export function readConfig(configPath = PATHS.config) {
  try {
    return JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    return null;
  }
}

export function gatewayPortOf(cfg, profileEnv = {}) {
  const fromProfile = Number(profileEnv.OPENCLAW_GATEWAY_PORT);
  if (Number.isInteger(fromProfile) && fromProfile > 0) return fromProfile;
  const fromCfg = Number(cfg?.gateway?.port);
  if (Number.isInteger(fromCfg) && fromCfg > 0) return fromCfg;
  return DEFAULT_PORT;
}

export function gatewayTokenOf(cfg) {
  const token = cfg?.gateway?.auth?.token;
  return typeof token === "string" && token.trim() ? token.trim() : null;
}

export function agentIdsOf(cfg) {
  const list = Array.isArray(cfg?.agents?.list) ? cfg.agents.list : [];
  return list
    .map((agent) => (typeof agent?.id === "string" ? agent.id.trim() : ""))
    .filter(Boolean);
}

// profile(.env 形) 解析:KEY=VALUE 每行,# 注释,值可带单双引号。纯解析不 source,
// 不执行任何 shell——这是 bash 层退役的关键替换点。
export function parseEnvFile(text) {
  const out = {};
  for (const rawLine of String(text ?? "").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export function loadProfile(profilePath = PATHS.profile) {
  if (!existsSync(profilePath)) return {};
  try {
    return parseEnvFile(readFileSync(profilePath, "utf8"));
  } catch {
    return {};
  }
}

// 网关进程 env 组装。产品默认路径零代理零隧道;个人部署特性(代理/CA)全部由
// profile 显式声明才进场。NO_PROXY 地板恒在(见 NO_PROXY_FLOOR)。
export function buildGatewayEnv({ profileEnv = {}, caBundleExists = false, caBundlePath = PATHS.caBundle } = {}) {
  const env = {};
  const proxy = profileEnv.OPENCLAW_HTTPS_PROXY || profileEnv.HTTPS_PROXY || "";
  if (proxy) {
    env.HTTPS_PROXY = proxy;
    env.HTTP_PROXY = profileEnv.OPENCLAW_HTTP_PROXY || profileEnv.HTTP_PROXY || proxy;
    const declared = (profileEnv.NO_PROXY || profileEnv.OPENCLAW_NO_PROXY || "")
      .split(",").map((s) => s.trim()).filter(Boolean);
    env.NO_PROXY = [...new Set([...NO_PROXY_FLOOR, ...declared])].join(",");
    env.no_proxy = env.NO_PROXY;
  }
  if (caBundleExists) {
    env.NODE_EXTRA_CA_CERTS = caBundlePath;
    env.NODE_USE_SYSTEM_CA = "1";
  }
  if (profileEnv.OPENCLAW_GATEWAY_FORCE_BIND_HOST) {
    env.OPENCLAW_GATEWAY_FORCE_BIND_HOST = profileEnv.OPENCLAW_GATEWAY_FORCE_BIND_HOST;
  }
  return env;
}

export function generateGatewayToken() {
  return randomBytes(24).toString("hex");
}

// example 配置的 token 占位判定:缺失/空/占位词都算未设,init 会补发真 token。
export function isPlaceholderToken(token) {
  if (typeof token !== "string" || !token.trim()) return true;
  return /REDACTED|CHANGE|YOUR[_-]?TOKEN|PLACEHOLDER|EXAMPLE/i.test(token);
}

export function frontendUrl(port, token) {
  return `http://localhost:${port}/watchdog/${token ? `?token=${token}` : ""}`;
}

// Node 版本门:node:sqlite v22.13.0 起免 flag(nodejs.org/api/sqlite.html History;record-plane 依赖)。
export const MIN_NODE = { major: 22, minor: 13 };

export function nodeVersionSatisfies(versionString, min = MIN_NODE) {
  const m = /^v?(\d+)\.(\d+)\./.exec(String(versionString ?? ""));
  if (!m) return false;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  return major > min.major || (major === min.major && minor >= min.minor);
}
