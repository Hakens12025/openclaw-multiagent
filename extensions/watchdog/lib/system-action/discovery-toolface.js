// discovery-toolface.js — ls/grep 发现工具面(D-G 实装,镜像 knowledge-toolface.js 的形状)。
//
// 它解决的错配:能力预设与 7 个 agent 的 tools.allow 早点名了 ls/grep,但宿主只组装了
// coding 组(read/write/edit/bash),ls/grep 是静默无效的幽灵声明——agent 拿到
// inbox/upstream/<producer>/ 这个目录却没有列目录的手段,只能猜文件名。
//
// 选型:pi-coding-agent 包里有现成实现(dist/core/tools/ls.js、grep.js),其
// package.json exports 的 "." 也确实导出 createLsTool/createGrepTool——但插件目录
// 没有任何 node_modules 链能解析到该包(实测裸导入 ERR_MODULE_NOT_FOUND:它嵌在
// 全局 openclaw 的嵌套 node_modules 里),硬编码全局绝对路径会把插件耦合到 node
// 版本与 openclaw 安装布局;且上游 grep 走 ensureTool 下载/调用 rg,超出本插件该
// 背的依赖。故原生最小实现,语义对齐上游:
//   ls   —— 列目录按大小写不敏感字母序、目录带 / 后缀、含 dotfiles、默认上限 500 条;
//   grep —— 返回 `路径:行号: 命中行`,默认上限 100 条,长行截 2000 字符;
//           纯 Node 递归遍历,不跟随符号链接、跳过 .git/node_modules 与二进制文件
//           (rg 的默认行为),支持 glob/ignoreCase/literal,不支持 context(上游
//           有,这里刻意不抄,需要时用 read 看上下文)。
//
// 安全面不在这里做:路径域(2b/2c)与敏感文件(checkToolCall)都在 before_tool_call
// 守卫链,经 DISCOVERY_TOOL_PATTERN 与 read 同等判定。

import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";

import { normalizeString } from "../core/normalize.js";
import { agentWorkspace, runtimeAgentConfigs } from "../state.js";

const LS_TOOL_NAME = "ls";
const GREP_TOOL_NAME = "grep";
const LS_DEFAULT_LIMIT = 500;
const GREP_DEFAULT_LIMIT = 100;
const MAX_LINE_LENGTH = 2000;
const MAX_GREP_FILE_BYTES = 10 * 1024 * 1024;
const SKIPPED_DIR_NAMES = new Set([".git", "node_modules"]);

// 与 knowledge/platform 工具族同款约定:execute 永不抛,错误进 payload,
// agent 拿到原因继续干活而不是整轮 tool call 失败。
function errorResult(message) {
  return { content: [{ type: "text", text: message }], details: { ok: false, error: message } };
}

function clampLimit(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// 极简 glob:* 不跨目录、** 跨目录、? 匹配单字符;不带 / 的模式只匹配
// basename(与 rg --glob '*.ts' 的直觉一致)。
function globToRegExp(glob) {
  const source = String(glob)
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\0")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\0/g, ".*");
  return new RegExp(`^${source}$`);
}

// 递归收集文件:不跟随符号链接(rg 同款默认,顺带封住链逃逸——守卫链只物理化
// 判定过根路径,子条目不再逐个判),跳过 .git/node_modules。
async function collectFiles(rootPath, files) {
  let entries;
  try {
    entries = await readdir(rootPath, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const fullPath = join(rootPath, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (SKIPPED_DIR_NAMES.has(entry.name)) continue;
      await collectFiles(fullPath, files);
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
}

function buildLsTool(cwd) {
  return {
    name: LS_TOOL_NAME,
    label: "ls",
    description: `List directory contents. Returns entries sorted alphabetically, with '/' suffix for directories. Includes dotfiles. Output is truncated to ${LS_DEFAULT_LIMIT} entries.`,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory to list (default: current directory)" },
        limit: { type: "number", description: `Maximum number of entries to return (default: ${LS_DEFAULT_LIMIT})` },
      },
    },
    async execute(_toolCallId, params = {}) {
      const dirPath = resolve(cwd, normalizeString(params?.path) || ".");
      const limit = clampLimit(params?.limit, LS_DEFAULT_LIMIT);
      let entries;
      try {
        const dirStat = await stat(dirPath);
        if (!dirStat.isDirectory()) return errorResult(`Not a directory: ${dirPath}`);
        entries = await readdir(dirPath);
      } catch {
        return errorResult(`Path not found: ${dirPath}`);
      }
      entries.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
      const results = [];
      let entryLimitReached = false;
      for (const entry of entries) {
        if (results.length >= limit) {
          entryLimitReached = true;
          break;
        }
        let suffix = "";
        try {
          const entryStat = await stat(join(dirPath, entry));
          if (entryStat.isDirectory()) suffix = "/";
        } catch {
          continue; // 与上游一致:stat 不动的条目跳过
        }
        results.push(entry + suffix);
      }
      let output = results.length > 0 ? results.join("\n") : "(empty directory)";
      const details = { ok: true, dir: dirPath, entryCount: results.length };
      if (entryLimitReached) {
        output += `\n\n[${limit} entries limit reached. Use limit=${limit * 2} for more]`;
        details.entryLimitReached = limit;
      }
      return { content: [{ type: "text", text: output }], details };
    },
  };
}

function buildGrepTool(cwd) {
  return {
    name: GREP_TOOL_NAME,
    label: "grep",
    description: `Search file contents for a pattern. Returns matching lines with file paths and line numbers. Output is truncated to ${GREP_DEFAULT_LIMIT} matches. Long lines are truncated to ${MAX_LINE_LENGTH} chars.`,
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Search pattern (regex or literal string)" },
        path: { type: "string", description: "Directory or file to search (default: current directory)" },
        glob: { type: "string", description: "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'" },
        ignoreCase: { type: "boolean", description: "Case-insensitive search (default: false)" },
        literal: { type: "boolean", description: "Treat pattern as literal string instead of regex (default: false)" },
        limit: { type: "number", description: `Maximum number of matches to return (default: ${GREP_DEFAULT_LIMIT})` },
      },
      required: ["pattern"],
    },
    async execute(_toolCallId, params = {}) {
      const pattern = normalizeString(params?.pattern);
      if (!pattern) return errorResult("pattern 为空");
      let matcher;
      try {
        matcher = new RegExp(params?.literal ? escapeRegExp(pattern) : pattern, params?.ignoreCase ? "i" : "");
      } catch (error) {
        return errorResult(`无效正则: ${error?.message || error}`);
      }
      let globRegex = null;
      const globRaw = normalizeString(params?.glob);
      if (globRaw) {
        try {
          globRegex = globToRegExp(globRaw);
        } catch {
          return errorResult(`无效 glob: ${globRaw}`);
        }
      }
      const searchPath = resolve(cwd, normalizeString(params?.path) || ".");
      const limit = clampLimit(params?.limit, GREP_DEFAULT_LIMIT);
      let isDir;
      try {
        isDir = (await stat(searchPath)).isDirectory();
      } catch {
        return errorResult(`Path not found: ${searchPath}`);
      }
      const files = [];
      if (isDir) {
        await collectFiles(searchPath, files);
      } else {
        files.push(searchPath);
      }
      const formatPath = (filePath) => {
        if (isDir) {
          const rel = relative(searchPath, filePath).split(sep).join("/");
          if (rel && !rel.startsWith("..")) return rel;
        }
        return basename(filePath);
      };
      const matches = [];
      let limitReached = false;
      let linesTruncated = false;
      for (const filePath of files) {
        if (matches.length >= limit) {
          limitReached = true;
          break;
        }
        const relPath = formatPath(filePath);
        if (globRegex && !globRegex.test(globRaw.includes("/") ? relPath : basename(filePath))) continue;
        let content;
        try {
          if ((await stat(filePath)).size > MAX_GREP_FILE_BYTES) continue;
          content = await readFile(filePath, "utf8");
        } catch {
          continue;
        }
        if (content.slice(0, 8000).includes("\0")) continue; // 二进制文件跳过(rg 同款默认)
        const lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (matches.length >= limit) {
            limitReached = true;
            break;
          }
          if (!matcher.test(lines[i])) continue;
          let lineText = lines[i];
          if (lineText.length > MAX_LINE_LENGTH) {
            lineText = lineText.slice(0, MAX_LINE_LENGTH);
            linesTruncated = true;
          }
          matches.push(`${relPath}:${i + 1}: ${lineText}`);
        }
      }
      if (matches.length === 0) {
        return { content: [{ type: "text", text: "No matches found" }], details: { ok: true, matchCount: 0 } };
      }
      const notices = [];
      const details = { ok: true, matchCount: matches.length };
      if (limitReached) {
        notices.push(`${limit} matches limit reached. Use limit=${limit * 2} for more, or refine pattern`);
        details.matchLimitReached = limit;
      }
      if (linesTruncated) {
        notices.push(`Some lines truncated to ${MAX_LINE_LENGTH} chars. Use read tool to see full lines`);
        details.linesTruncated = true;
      }
      const output = matches.join("\n") + (notices.length > 0 ? `\n\n[${notices.join(". ")}]` : "");
      return { content: [{ type: "text", text: output }], details };
    },
  };
}

// **必须同步**:框架的 registerTool 工厂不 await(knowledge-toolface.js 同名注释),
// 工作区根在这里取定,execute 里用。
export function buildDiscoveryTools({ agentId } = {}) {
  const id = normalizeString(agentId);
  if (!id || !runtimeAgentConfigs.has(id)) return [];
  const cwd = agentWorkspace(id);
  if (!cwd) return [];
  return [buildLsTool(cwd), buildGrepTool(cwd)];
}

export function listDiscoveryToolNames() {
  return [LS_TOOL_NAME, GREP_TOOL_NAME];
}
