// ctl-proc.js — openclawctl 的进程/端口原语(跨平台,零 shell 工具依赖)。
// 端口探测用 node:net 直连,不再 lsof;宿主 CLI 调用统一走 runHost,
// Windows 下 npm 全局 bin 是 .cmd 需 shell,平台分支收口在这一个函数里。

import { spawnSync } from "node:child_process";
import net from "node:net";
import { setTimeout as sleep } from "node:timers/promises";

// 端口是否有监听者:能建立 TCP 连接 = 有。比解析 lsof 输出可移植且无歧义。
export function probePort(port, { host = "127.0.0.1", timeoutMs = 1200 } = {}) {
  return new Promise((resolvePromise) => {
    const socket = net.connect({ port, host });
    const done = (listening) => {
      socket.destroy();
      resolvePromise(listening);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

export async function waitForPort(port, { want, timeoutMs = 20000, intervalMs = 1000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const listening = await probePort(port);
    if (listening === want) return true;
    if (Date.now() >= deadline) return false;
    await sleep(intervalMs);
  }
}

// 宿主 CLI 调用(openclaw gateway …/config validate/health)。
// stdio 默认吞掉(编排层自己打印节奏),要输出的传 { capture: true }。
export function runHost(args, { env = {}, capture = false, timeoutMs = 60000 } = {}) {
  const result = spawnSync("openclaw", args, {
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: timeoutMs,
    shell: process.platform === "win32",
    stdio: capture ? "pipe" : "ignore",
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: capture ? String(result.stdout ?? "") : "",
    stderr: capture ? String(result.stderr ?? "") : "",
    error: result.error || null,
  };
}

export function hostCliAvailable() {
  const probe = runHost(["--version"], { capture: true, timeoutMs: 15000 });
  return { available: probe.ok, version: probe.stdout.trim() || null, error: probe.error?.message || null };
}

// darwin 专属升级手段:宿主 stop 后端口仍被占时 bootout launchd 服务
// (双网关事故族的护栏,平台分支只此一处;非 darwin 平台直接返回 false 交回 fail-loud)。
export function darwinBootoutGateway() {
  if (process.platform !== "darwin") return false;
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (uid === null) return false;
  const result = spawnSync("launchctl", ["bootout", `gui/${uid}/ai.openclaw.gateway`], {
    encoding: "utf8",
    timeout: 15000,
    stdio: "ignore",
  });
  return result.status === 0;
}
