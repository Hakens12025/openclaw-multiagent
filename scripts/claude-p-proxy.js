#!/usr/bin/env node
// claude-p-proxy.js
// OpenAI /v1/chat/completions  →  `claude -p` (Claude Code 非交互模式, Max 订阅鉴权)
//
// 目的: 让 OpenClaw 用 Claude 订阅的 "Agent SDK 额度"(6/15 起, Max20 = $200/月)
// 而非裸 Messages API + 单独计费。OpenClaw provider 的 baseUrl 指向本代理即可。
//
// 用法:
//   PORT=11436 node scripts/claude-p-proxy.js
// 健康检查:
//   curl http://127.0.0.1:11436/healthz
//
// 注意:
//  - 每个请求 spawn 一个 claude 进程(~6s+ 延迟、有系统提示词缓存开销),并发吃力,
//    适合把 Claude 只派给 operator/reviewer 等高价值低频环节,不做全局默认。
//  - 用 --system-prompt 把 OpenClaw agent 的 system 消息整体替换 Claude Code 默认提示词。
//  - 鉴权走宿主机上 claude 的订阅登录态;provider 的 apiKey 字段填什么都行(被忽略)。

import http from "node:http";
import { spawn } from "node:child_process";
import { mkdirSync, appendFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const LISTEN_PORT = parseInt(process.env.PORT || "11436", 10);
const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";
// 中性工作目录:避免 claude -p 加载项目 CLAUDE.md / 仓库上下文污染 agent 行为。
const WORK_CWD = process.env.CLAUDE_P_CWD || join(tmpdir(), "claude-p-proxy-cwd");
const OPENCLAW_HOME = process.env.OPENCLAW_HOME || join(process.env.HOME || homedir(), ".openclaw");
const TRACE_FILE = process.env.TRACE_FILE || join(OPENCLAW_HOME, "logs", "claude-p-proxy-trace.ndjson");

try { mkdirSync(WORK_CWD, { recursive: true }); } catch {}

function trace(entry) {
  try {
    mkdirSync(join(OPENCLAW_HOME, "logs"), { recursive: true });
    appendFileSync(TRACE_FILE, JSON.stringify({ t: new Date().toISOString(), ...entry }) + "\n");
  } catch {}
}

// claude -p --model 接受 sonnet/opus/haiku 别名或完整 ID。归一到别名最稳。
export function mapModel(model) {
  const m = String(model || "").toLowerCase();
  if (m.includes("opus")) return "opus";
  if (m.includes("haiku")) return "haiku";
  return "sonnet";
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part === "string" ? part : part?.text || "")).join("");
  }
  return content == null ? "" : String(content);
}

// 拆 OpenAI messages → { systemPrompt, userPrompt }
export function buildPrompt(messages = []) {
  const system = [];
  const turns = [];
  for (const msg of Array.isArray(messages) ? messages : []) {
    const body = textOf(msg?.content);
    if (msg?.role === "system") system.push(body);
    else if (msg?.role === "assistant") turns.push(`Assistant: ${body}`);
    else turns.push(body && turns.length ? `User: ${body}` : body); // 首条 user 不加标签
  }
  return { systemPrompt: system.join("\n\n").trim(), userPrompt: turns.join("\n\n").trim() };
}

function runClaude({ model, systemPrompt, userPrompt }) {
  return new Promise((resolve) => {
    const args = ["-p", "--output-format", "json", "--model", mapModel(model)];
    if (systemPrompt) args.push("--system-prompt", systemPrompt);
    const child = spawn(CLAUDE_BIN, args, { cwd: WORK_CWD, env: process.env });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => resolve({ ok: false, error: `spawn failed: ${e.message}` }));
    child.on("close", (code) => {
      if (code !== 0) return resolve({ ok: false, error: `claude exit ${code}: ${err.slice(0, 300)}` });
      let parsed;
      try { parsed = JSON.parse(out); } catch (e) { return resolve({ ok: false, error: `bad json: ${e.message}` }); }
      if (parsed?.is_error || parsed?.api_error_status) {
        return resolve({ ok: false, error: parsed?.result || `api_error ${parsed?.api_error_status}` });
      }
      resolve({ ok: true, text: parsed?.result ?? "", usage: parsed?.usage || {}, cost: parsed?.total_cost_usd });
    });
    child.stdin.write(userPrompt || "");
    child.stdin.end();
  });
}

function sendJson(res, status, obj) {
  const buf = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": buf.length });
  res.end(buf);
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/healthz") return sendJson(res, 200, { ok: true, backend: "claude -p", port: LISTEN_PORT });
  // 宽松匹配:无论 baseUrl 末尾带不带 /v1,只要路径含 chat/completions 即受理。
  if (req.method !== "POST" || !req.url.includes("chat/completions")) {
    return sendJson(res, 404, { error: { message: "only POST …/chat/completions" } });
  }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    let payload;
    try { payload = JSON.parse(body || "{}"); } catch { return sendJson(res, 400, { error: { message: "invalid json body" } }); }
    const { systemPrompt, userPrompt } = buildPrompt(payload.messages);
    const started = Date.now();
    const r = await runClaude({ model: payload.model, systemPrompt, userPrompt });
    if (!r.ok) {
      trace({ model: payload.model, ok: false, error: r.error, ms: Date.now() - started });
      return sendJson(res, 502, { error: { message: r.error, type: "claude_p_proxy_error" } });
    }
    trace({ model: payload.model, ok: true, cost: r.cost, usage: r.usage, ms: Date.now() - started });
    sendJson(res, 200, {
      id: `chatcmpl-claudep-${started}`,
      object: "chat.completion",
      created: Math.floor(started / 1000),
      model: payload.model || mapModel(payload.model),
      choices: [{ index: 0, message: { role: "assistant", content: r.text }, finish_reason: "stop" }],
      usage: {
        prompt_tokens: r.usage.input_tokens || 0,
        completion_tokens: r.usage.output_tokens || 0,
        total_tokens: (r.usage.input_tokens || 0) + (r.usage.output_tokens || 0),
      },
    });
  });
});

// 仅监听本机回环,避免暴露订阅鉴权通道。
if (process.env.CLAUDE_P_PROXY_NO_LISTEN !== "1") {
  server.listen(LISTEN_PORT, "127.0.0.1", () => {
    console.log(`[claude-p-proxy] listening http://127.0.0.1:${LISTEN_PORT}  cwd=${WORK_CWD}`);
  });
}
