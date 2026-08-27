// agent-reveal-file.js — 在系统文件管理器中定位文件（reveal，跨平台）
//
// 「工作流」页 session 查看器的文件超链接 → 调用本 helper 在文件管理器里定位文件。
// 平台分派（纯函数 revealCommandFor，可单测）：
//   darwin → open -R <path>（Finder 选中该文件）
//   linux  → xdg-open <dir>（打开所在目录；xdg-open 无“选中”语义，开父目录是最近似的 reveal）
//   win32  → explorer /select,<path>
//   其它   → 优雅降级：resolve { ok:false, reason }，不抛
// 严格白名单：resolve 后必须落在 ~/.openclaw/{workspaces,control-plane,contracts,agents}
// 之内，拒绝 .. 逃逸。用 execFile（不走 shell）避免命令注入。

import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

const OC_ROOT = join(homedir(), ".openclaw");

// 允许 reveal 的根目录白名单（resolve 后必须落在其一之内）
const ALLOWED_ROOTS = Object.freeze([
  join(OC_ROOT, "workspaces"),
  join(OC_ROOT, "control-plane"),
  join(OC_ROOT, "contracts"),
  join(OC_ROOT, "agents"),
]);

/**
 * 判断 resolvedPath 是否落在某个白名单根之内（含根本身）。
 * 用 path + sep 前缀校验，防止 /foo/bar-evil 误匹配 /foo/bar。
 */
export function isPathWithinAllowedRoots(resolvedPath) {
  return ALLOWED_ROOTS.some(
    (root) => resolvedPath === root || resolvedPath.startsWith(root + sep),
  );
}

/**
 * 纯函数：按平台给出 reveal 命令。不支持的平台返回 null（调用方降级）。
 *
 * @param {string} platform  process.platform 取值（"darwin" | "linux" | "win32" | …）
 * @param {string} resolvedPath  已过白名单的绝对路径
 * @returns {{ cmd:string, args:string[] } | null}
 */
export function revealCommandFor(platform, resolvedPath) {
  switch (platform) {
    case "darwin":
      return { cmd: "open", args: ["-R", resolvedPath] };
    case "linux":
      return { cmd: "xdg-open", args: [dirname(resolvedPath)] };
    case "win32":
      return { cmd: "explorer", args: [`/select,${resolvedPath}`] };
    default:
      return null;
  }
}

/**
 * reveal 一个文件。白名单校验失败抛错（调用方映射为 4xx）。
 * 通过白名单 → revealCommandFor(platform) 分派 → execFile。
 * 平台不支持时不抛：resolve { ok:false, reason }（调用方映射为 501）。
 *
 * @param {string} inputPath
 * @param {{ exec?: Function, platform?: string }} [deps]  注入 exec/platform 便于测试
 * @returns {Promise<{ ok:true, resolvedPath:string } | { ok:false, reason:string }>}
 */
export function revealFileInFinder(inputPath, { exec = execFile, platform = process.platform } = {}) {
  const raw = typeof inputPath === "string" ? inputPath.trim() : "";
  if (!raw) {
    return Promise.reject(new Error("path required"));
  }
  // Expand a leading ~ (or ~/) to the home dir BEFORE resolve — node's resolve() does not expand ~,
  // and UI callers (agents page) hand us compactHomePath() forms like "~/.openclaw/workspaces/<id>/SOUL.md".
  // The ALLOWED_ROOTS whitelist below still gates the expanded path, so this widens input forms, not access.
  const expanded = raw === "~" || raw.startsWith(`~${sep}`) || raw.startsWith("~/")
    ? join(homedir(), raw.slice(1))
    : raw;
  const resolvedPath = resolve(expanded);
  if (!isPathWithinAllowedRoots(resolvedPath)) {
    return Promise.reject(new Error("path not allowed"));
  }
  const command = revealCommandFor(platform, resolvedPath);
  if (!command) {
    return Promise.resolve({ ok: false, reason: `reveal not supported on platform "${platform}"` });
  }
  return new Promise((resolvePromise, rejectPromise) => {
    exec(command.cmd, command.args, (error) => {
      if (error) {
        rejectPromise(error);
        return;
      }
      resolvePromise({ ok: true, resolvedPath });
    });
  });
}
