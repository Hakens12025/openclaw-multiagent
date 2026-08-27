// ctl-commands.js — openclawctl 子命令实现(init/doctor/start/stop/restart/status/logs)。
// 吸收并退役 bash 层(setup.sh/start.sh/clean-restart-gateway.sh):服务单元交宿主
// `openclaw gateway install`(launchd/systemd/schtasks 三平台原生),本层只做
// 预检/env 组装/编排/等待/汇报。个人部署特性(代理/SSH 隧道/CA)全部 profile 可选,
// 产品默认路径零依赖。

import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

import {
  ROOT, EXPECTED_ROOT, PATHS, MIN_NODE,
  readConfig, gatewayPortOf, gatewayTokenOf, agentIdsOf,
  loadProfile, buildGatewayEnv, generateGatewayToken, isPlaceholderToken,
  frontendUrl, nodeVersionSatisfies,
} from "./ctl-env.js";
import {
  probePort, waitForPort, runHost, hostCliAvailable, darwinBootoutGateway,
} from "./ctl-proc.js";

const log = (msg) => console.log(msg);
const warn = (msg) => console.warn(msg);

// ── init ─────────────────────────────────────────────────────────────────────
// 幂等初始化:配置生成(token 自动签发)+ 目录骨架(workspace 按花名册派生,不硬编码
// agent 名——setup.sh 硬编码的 worker-a/kksl/evaluator 花名册早已退役,是活教材)。
export async function cmdInit({ withQqbot = false } = {}) {
  log("═══ openclawctl init");

  let cfg = readConfig();
  if (!cfg) {
    if (!existsSync(PATHS.configExample)) {
      warn(`✗ 缺 ${PATHS.configExample},无法生成配置`);
      return 1;
    }
    cfg = JSON.parse(readFileSync(PATHS.configExample, "utf8"));
    log(`✓ 从 openclaw.example.json 生成 openclaw.json`);
  }
  if (isPlaceholderToken(gatewayTokenOf(cfg))) {
    cfg.gateway = cfg.gateway || {};
    cfg.gateway.auth = cfg.gateway.auth || {};
    cfg.gateway.auth.token = generateGatewayToken();
    log("✓ 已自动签发 gateway token(48 hex)");
  }
  writeFileSync(PATHS.config, JSON.stringify(cfg, null, 2));

  mkdirSync(PATHS.logsDir, { recursive: true });
  mkdirSync(join(ROOT, "control-plane"), { recursive: true });
  const agents = agentIdsOf(cfg);
  for (const agentId of agents) {
    mkdirSync(join(PATHS.workspacesDir, agentId), { recursive: true });
  }
  log(`✓ 目录骨架就绪(workspaces × ${agents.length}:${agents.join(", ") || "无 agent"})`);

  if (withQqbot && existsSync(join(PATHS.qqbotDir, "package.json"))) {
    log("… 安装 qqbot 依赖(npm install)");
    const npm = spawnSync("npm", ["install", "--silent"], {
      cwd: PATHS.qqbotDir, stdio: "ignore", shell: process.platform === "win32", timeout: 300000,
    });
    log(npm.status === 0 ? "✓ qqbot 依赖就绪" : "⚠ qqbot npm install 失败(QQ 渠道可选,不影响主链路)");
  }

  log("");
  log("下一步:");
  log("  1. 编辑 openclaw.json 填模型 API key(models.providers.*.apiKey)");
  log("  2. node openclawctl.js doctor   # 环境体检");
  log("  3. node openclawctl.js start    # 启动");
  return 0;
}

// ── doctor ───────────────────────────────────────────────────────────────────
export async function cmdDoctor() {
  const checks = [];
  const add = (ok, name, detail) => checks.push({ ok, name, detail });

  add(nodeVersionSatisfies(process.version), `Node ≥ ${MIN_NODE.major}.${MIN_NODE.minor}`, `当前 ${process.version}(record-plane 依赖 node:sqlite)`);
  try {
    await import("node:sqlite");
    add(true, "node:sqlite 可用", "记账真值层就绪");
  } catch {
    add(false, "node:sqlite 可用", "无法加载——请升级 Node");
  }

  const host = hostCliAvailable();
  add(host.available, "宿主 CLI(openclaw)", host.available ? `版本 ${host.version}` : `未找到:npm install -g openclaw(${host.error || "PATH 缺席"})`);

  add(ROOT === EXPECTED_ROOT, "安装位置", ROOT === EXPECTED_ROOT ? ROOT : `当前 ${ROOT},宿主期望 ${EXPECTED_ROOT}——请克隆到该位置`);

  const cfg = readConfig();
  add(!!cfg, "openclaw.json", cfg ? "存在且可解析" : "缺失或损坏——先跑 node openclawctl.js init");
  if (cfg) {
    const token = gatewayTokenOf(cfg);
    add(!isPlaceholderToken(token), "gateway token", isPlaceholderToken(token) ? "未设置/占位符——跑 init 自动签发" : "已设置");
    const agents = agentIdsOf(cfg);
    add(agents.length > 0, "agent 花名册", agents.length ? `${agents.length} 个:${agents.join(", ")}` : "agents.list 为空");
    const missingWs = agents.filter((id) => !existsSync(join(PATHS.workspacesDir, id)));
    add(missingWs.length === 0, "workspace 目录", missingWs.length ? `缺 ${missingWs.join(", ")}——跑 init 补齐` : "齐全");
  }

  const port = gatewayPortOf(cfg, loadProfile());
  const listening = await probePort(port);
  add(true, `端口 ${port}`, listening ? "有监听者(网关在跑或被占)" : "空闲(可启动)");

  try {
    mkdirSync(PATHS.logsDir, { recursive: true });
    statSync(PATHS.logsDir);
    add(true, "日志目录可写", PATHS.logsDir);
  } catch {
    add(false, "日志目录可写", `${PATHS.logsDir} 不可写`);
  }

  const svc = process.platform === "darwin" ? "launchd"
    : process.platform === "linux" ? "systemd(user)"
    : process.platform === "win32" ? "schtasks"
    : process.platform;
  add(true, "服务管理器", `${process.platform} → ${svc}(由宿主 gateway install 生成)`);

  log("═══ openclawctl doctor");
  let failed = 0;
  for (const c of checks) {
    if (!c.ok) failed += 1;
    log(` ${c.ok ? "✓" : "✗"} ${c.name} — ${c.detail}`);
  }
  log(failed === 0 ? "\n体检通过。" : `\n${failed} 项不过——按提示处理后重跑。`);
  return failed === 0 ? 0 : 1;
}

// ── start / stop / restart ───────────────────────────────────────────────────
async function stopGateway(port) {
  runHost(["gateway", "stop"]);
  if (await waitForPort(port, { want: false, timeoutMs: 12000 })) return true;
  // 双网关事故族护栏:宿主 stop 停不干净时,darwin 升级 bootout;仍占则 fail-loud,
  // 绝不按命令行模糊匹配杀进程(pkill 误杀 npm test 的历史教训)。
  if (darwinBootoutGateway() && await waitForPort(port, { want: false, timeoutMs: 8000 })) return true;
  return !(await probePort(port));
}

export async function cmdStart() {
  const cfg = readConfig();
  if (!cfg) {
    warn("✗ 无 openclaw.json——先跑 node openclawctl.js init");
    return 1;
  }
  const profileEnv = loadProfile();
  const port = gatewayPortOf(cfg, profileEnv);
  const token = gatewayTokenOf(cfg);

  log("[start] 校验配置…");
  const validate = runHost(["config", "validate"], { capture: true });
  if (!validate.ok) {
    warn(`✗ 配置校验失败:\n${validate.stderr || validate.stdout}`);
    return 1;
  }

  // CA bundle:文件在才启用;darwin 且刷新脚本可执行时先刷新(可选个人部署特性)。
  if (process.platform === "darwin" && existsSync(PATHS.caRefreshScript) && existsSync(PATHS.caBundle)) {
    spawnSync("bash", [PATHS.caRefreshScript, PATHS.caBundle], { stdio: "ignore", timeout: 30000 });
  }
  const env = buildGatewayEnv({ profileEnv, caBundleExists: existsSync(PATHS.caBundle) });

  log("[start] 停旧实例…");
  if (!(await stopGateway(port))) {
    warn(`✗ 端口 ${port} 仍被占用且非宿主所辖——不盲杀,请人工确认占用者后重试`);
    return 1;
  }

  log(`[start] 安装并启动网关服务(端口 ${port}${env.HTTPS_PROXY ? `,代理 ${env.HTTPS_PROXY}` : ",无代理"})…`);
  const install = runHost(["gateway", "install", "--force", "--port", String(port)], { env, capture: true });
  if (!install.ok) {
    warn(`✗ gateway install 失败:\n${install.stderr || install.stdout}`);
    return 1;
  }
  const start = runHost(["gateway", "start"], { capture: true });
  if (!start.ok) {
    warn(`✗ gateway start 失败:\n${start.stderr || start.stdout}`);
    return 1;
  }

  if (!(await waitForPort(port, { want: true, timeoutMs: 25000 }))) {
    warn("✗ 网关 25s 未就绪,最近日志:");
    tailFile(PATHS.gatewayErrLog, 20);
    return 1;
  }

  log("");
  log("══════════════════════════════════");
  log(" OpenClaw 已启动");
  log(`   前端:  ${frontendUrl(port, token)}`);
  log(`   日志:  ${PATHS.gatewayLog}`);
  log("══════════════════════════════════");
  return 0;
}

export async function cmdStop() {
  const port = gatewayPortOf(readConfig(), loadProfile());
  log("[stop] 停止网关…");
  if (await stopGateway(port)) {
    log("✓ 已停止");
    return 0;
  }
  warn(`✗ 端口 ${port} 仍被占——占用者不是宿主所辖服务,请人工处理`);
  return 1;
}

export async function cmdRestart() {
  const stopCode = await cmdStop();
  if (stopCode !== 0) return stopCode;
  return cmdStart();
}

export async function cmdStatus() {
  const cfg = readConfig();
  const port = gatewayPortOf(cfg, loadProfile());
  const listening = await probePort(port);
  log(`网关端口 ${port}: ${listening ? "✓ 监听中" : "✗ 未运行"}`);
  if (listening) {
    const health = runHost(["health", "--json", "--timeout", "5000"], { capture: true, timeoutMs: 15000 });
    log(`宿主健康检查: ${health.ok ? "✓ ok" : "✗ 异常"}`);
    log(`前端: ${frontendUrl(port, gatewayTokenOf(cfg))}`);
  }
  return listening ? 0 : 1;
}

// ── logs ─────────────────────────────────────────────────────────────────────
function tailFile(path, lines) {
  try {
    const content = readFileSync(path, "utf8").trimEnd().split("\n");
    for (const line of content.slice(-lines)) log(line);
  } catch {
    warn(`(无法读取 ${path})`);
  }
}

export async function cmdLogs({ lines = 40, errors = false } = {}) {
  const target = errors ? PATHS.gatewayErrLog : PATHS.gatewayLog;
  log(`═══ ${target}(末 ${lines} 行)`);
  tailFile(target, lines);
  return 0;
}
