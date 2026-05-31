#!/usr/bin/env node
// ollama-nothink-proxy.js
// OpenAI /v1/chat/completions → Ollama native /api/chat with think:false
// Makes Qwen3.5 thinking models usable by clients that can't send native Ollama params.

import http from "node:http";
import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const LISTEN_PORT = parseInt(process.env.PORT || "11435", 10);
const OLLAMA_HOST = process.env.OLLAMA_HOST || "127.0.0.1";
const OLLAMA_PORT = parseInt(process.env.OLLAMA_PORT || "11434", 10);
const TRACE_FILE = resolveTraceFile(process.env);

export function resolveOpenClawHome(env = process.env) {
  return env.OPENCLAW_HOME || env.OPENCLAW_DIR || join(env.HOME || homedir(), ".openclaw");
}

export function resolveTraceFile(env = process.env) {
  return env.TRACE_FILE || join(resolveOpenClawHome(env), "logs", "ollama-nothink-trace.ndjson");
}

export function buildOllamaChatPayload(payload = {}) {
  return {
    model: payload.model,
    messages: payload.messages || [],
    think: false,
    stream: false,
    options: {
      ...(payload.temperature !== undefined && { temperature: payload.temperature }),
      ...(payload.top_p !== undefined && { top_p: payload.top_p }),
      ...(payload.max_tokens !== undefined && { num_predict: payload.max_tokens }),
    },
  };
}

function trace(entry) {
  try { appendFileSync(TRACE_FILE, JSON.stringify(entry) + "\n"); } catch {}
}

function sendJson(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(json),
  });
  res.end(json);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = "";
    req.on("data", (c) => { buf += c; });
    req.on("end", () => resolve(buf));
    req.on("error", reject);
  });
}

function ollamaRequest(path, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = http.request({
      host: OLLAMA_HOST, port: OLLAMA_PORT, path, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    }, (r) => {
      let data = "";
      r.on("data", (c) => { data += c; });
      r.on("end", () => {
        try { resolve({ status: r.statusCode, body: JSON.parse(data) }); }
        catch (e) { reject(new Error(`bad ollama response: ${data.slice(0, 200)}`)); }
      });
    });
    req.on("error", reject);
    req.end(body);
  });
}

async function handleChat(req, res) {
  let payload;
  try { payload = JSON.parse(await readBody(req)); }
  catch { return sendJson(res, 400, { error: "invalid JSON" }); }

  const ollamaPayload = buildOllamaChatPayload(payload);

  const reqTs = Date.now();
  const reqId = `req-${reqTs}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    const { status, body } = await ollamaRequest("/api/chat", ollamaPayload);
    if (status !== 200) {
      trace({ id: reqId, ts: reqTs, status, model: payload.model, messages: payload.messages, error: body?.error });
      return sendJson(res, status, { error: body?.error || "ollama error" });
    }
    const msg = body.message || {};
    trace({
      id: reqId,
      ts: reqTs,
      elapsedMs: Date.now() - reqTs,
      model: payload.model,
      messages: payload.messages,
      response: msg.content || "",
      promptTokens: body.prompt_eval_count || 0,
      completionTokens: body.eval_count || 0,
    });
    sendJson(res, 200, {
      id: `chatcmpl-${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: payload.model,
      choices: [{
        index: 0,
        message: { role: msg.role || "assistant", content: msg.content || "" },
        finish_reason: body.done_reason || "stop",
      }],
      usage: {
        prompt_tokens: body.prompt_eval_count || 0,
        completion_tokens: body.eval_count || 0,
        total_tokens: (body.prompt_eval_count || 0) + (body.eval_count || 0),
      },
    });
  } catch (e) {
    trace({ id: reqId, ts: reqTs, model: payload.model, error: e.message });
    sendJson(res, 502, { error: e.message });
  }
}

async function handleModels(req, res) {
  try {
    const r = await new Promise((resolve, reject) => {
      http.get({ host: OLLAMA_HOST, port: OLLAMA_PORT, path: "/api/tags" }, (r) => {
        let data = "";
        r.on("data", (c) => { data += c; });
        r.on("end", () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
      }).on("error", reject);
    });
    sendJson(res, 200, {
      object: "list",
      data: (r.models || []).map((m) => ({ id: m.name, object: "model", created: Date.now(), owned_by: "ollama" })),
    });
  } catch (e) {
    sendJson(res, 502, { error: e.message });
  }
}

async function handleNativeChat(req, res) {
  const reqTs = Date.now();
  const reqId = `req-${reqTs}-${Math.random().toString(36).slice(2, 8)}`;
  let payload;
  try { payload = JSON.parse(await readBody(req)); }
  catch { return sendJson(res, 400, { error: "invalid JSON" }); }

  const patched = { ...payload, think: false };
  const isStream = patched.stream !== false;

  try {
    if (!isStream) {
      const { status, body } = await ollamaRequest("/api/chat", { ...patched, stream: false });
      const content = body?.message?.content || "";
      trace({
        id: reqId, ts: reqTs, kind: "native_chat", elapsedMs: Date.now() - reqTs,
        model: patched.model, messages: patched.messages, response: content,
        promptTokens: body?.prompt_eval_count || 0, completionTokens: body?.eval_count || 0,
      });
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
      return;
    }

    // Streaming: forward raw NDJSON stream from ollama, collect content for trace
    const upstreamReq = http.request({
      host: OLLAMA_HOST, port: OLLAMA_PORT, path: "/api/chat", method: "POST",
      headers: { "Content-Type": "application/json" },
    }, (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
      let collected = "";
      upstreamRes.on("data", (chunk) => {
        res.write(chunk);
        try {
          for (const line of String(chunk).split("\n")) {
            if (!line.trim()) continue;
            const obj = JSON.parse(line);
            if (obj?.message?.content) collected += obj.message.content;
          }
        } catch {}
      });
      upstreamRes.on("end", () => {
        res.end();
        trace({
          id: reqId, ts: reqTs, kind: "native_chat_stream", elapsedMs: Date.now() - reqTs,
          model: patched.model, messages: patched.messages, response: collected,
        });
      });
    });
    upstreamReq.on("error", (e) => { sendJson(res, 502, { error: e.message }); });
    upstreamReq.write(JSON.stringify(patched));
    upstreamReq.end();
  } catch (e) {
    trace({ id: reqId, ts: reqTs, error: e.message });
    sendJson(res, 502, { error: e.message });
  }
}

export function createProxyServer() {
  return http.createServer(async (req, res) => {
    const url = (req.url || "").split("?")[0];
    trace({ kind: "req", ts: Date.now(), method: req.method, url: req.url });
    if (req.method === "POST" && url === "/v1/chat/completions") return handleChat(req, res);
    if (req.method === "POST" && url === "/api/chat") return handleNativeChat(req, res);
    if (req.method === "GET" && url === "/v1/models") return handleModels(req, res);
    const upstream = http.request({
      host: OLLAMA_HOST, port: OLLAMA_PORT, path: req.url, method: req.method,
      headers: req.headers,
    }, (r) => {
      res.writeHead(r.statusCode || 502, r.headers);
      r.pipe(res);
    });
    upstream.on("error", (e) => { sendJson(res, 502, { error: e.message }); });
    req.pipe(upstream);
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const server = createProxyServer();
  server.listen(LISTEN_PORT, "127.0.0.1", () => {
    console.log(`[nothink-proxy] listening on http://127.0.0.1:${LISTEN_PORT} -> ollama ${OLLAMA_HOST}:${OLLAMA_PORT}`);
  });
}
