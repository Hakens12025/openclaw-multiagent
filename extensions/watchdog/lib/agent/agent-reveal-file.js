// agent-reveal-file.js — 在 macOS Finder 中定位文件（reveal）
//
// 「工作流」页 session 查看器的文件超链接 → 调用本 helper 在 Finder 选中文件。
// 严格白名单：resolve 后必须落在 ~/.openclaw/{workspaces,control-plane,contracts,agents}
// 之内，拒绝 .. 逃逸。用 execFile（不走 shell）避免命令注入。

import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

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
 * reveal 一个文件。白名单校验失败抛错（调用方映射为 4xx）。
 * 通过白名单 → execFile("open", ["-R", resolvedPath])。
 *
 * @param {string} inputPath
 * @param {{ exec?: Function }} [deps]  注入 exec 便于测试（默认 child_process.execFile）
 * @returns {Promise<{ ok:true, resolvedPath:string }>}
 */
export function revealFileInFinder(inputPath, { exec = execFile } = {}) {
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
  return new Promise((resolvePromise, rejectPromise) => {
    exec("open", ["-R", resolvedPath], (error) => {
      if (error) {
        rejectPromise(error);
        return;
      }
      resolvePromise({ ok: true, resolvedPath });
    });
  });
}
