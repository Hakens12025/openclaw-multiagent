import test from "node:test";
import assert from "node:assert/strict";

import {
  buildOllamaChatPayload,
  createProxyServer,
  resolveOpenClawHome,
  resolveTraceFile,
} from "../../../scripts/ollama-nothink-proxy.js";

test("nothink proxy derives OpenClaw paths from environment", () => {
  assert.equal(
    resolveOpenClawHome({ OPENCLAW_HOME: "/tmp/oc-home", HOME: "/tmp/home" }),
    "/tmp/oc-home",
  );
  assert.equal(
    resolveOpenClawHome({ OPENCLAW_DIR: "/tmp/oc-dir", HOME: "/tmp/home" }),
    "/tmp/oc-dir",
  );
  assert.equal(
    resolveTraceFile({ OPENCLAW_HOME: "/tmp/oc-home", HOME: "/tmp/home" }),
    "/tmp/oc-home/logs/ollama-nothink-trace.ndjson",
  );
  assert.equal(
    resolveTraceFile({ TRACE_FILE: "/tmp/custom.ndjson", OPENCLAW_HOME: "/tmp/oc-home" }),
    "/tmp/custom.ndjson",
  );
});

test("nothink proxy converts OpenAI chat payload into Ollama no-think request", () => {
  assert.deepEqual(
    buildOllamaChatPayload({
      model: "qwen3.5:0.8b",
      messages: [{ role: "user", content: "hello" }],
      temperature: 0.2,
      top_p: 0.9,
      max_tokens: 64,
    }),
    {
      model: "qwen3.5:0.8b",
      messages: [{ role: "user", content: "hello" }],
      think: false,
      stream: false,
      options: {
        temperature: 0.2,
        top_p: 0.9,
        num_predict: 64,
      },
    },
  );
});

test("nothink proxy exports server factory without listening on import", () => {
  const server = createProxyServer();
  assert.equal(server.listening, false);
  server.close();
});
