// tests/suite-model-units.test.js — model 套件纯逻辑锁（零网络：fetch 全 mock，无网关依赖）
//
// 覆盖两块：
//   ① 裸 API 连通（吸收自原 tests/suite-providers.test.js，逻辑原样搬进 suite-model.js）：
//      协议门 / 本地判定 / 清单枚举 / 探测判定 / 单 format 探测（mock fetch）。
//   ② 全链路实例的纯信号映射：临时 agent id 铸造 / e2e 门控 / 终态观测 → CheckResult 载荷。

import test from "node:test";
import assert from "node:assert/strict";

import {
  MODEL_E2E_BUDGET_MS,
  MODEL_OK_MARKER,
  MODEL_PROBE_AGENT_PREFIX,
  MODEL_PROBE_TASK,
  PROBE_FORMATS,
  buildModelProbeAgentId,
  classifyModelE2eOutcome,
  classifyProviderProbe,
  isLocalBaseUrl,
  isOpenAiCompletionsApi,
  listCredentialedProviders,
  probeProviderFormat,
  shouldRunModelE2e,
  buildHostRosterSkipEvidence,
  MODEL_E2E_BIRTH_GATE_MS,
} from "../lib/formal-runtime/suite-model.js";

// ── ① 裸 API 连通（吸收自 suite-providers 锁）─────────────────────────────────

test("isOpenAiCompletionsApi accepts openai-completions/openai/unset, rejects other protocols", () => {
  assert.equal(isOpenAiCompletionsApi("openai-completions"), true);
  assert.equal(isOpenAiCompletionsApi("openai"), true);
  assert.equal(isOpenAiCompletionsApi(""), true);   // unset → OpenAI-compatible default
  assert.equal(isOpenAiCompletionsApi(null), true);
  assert.equal(isOpenAiCompletionsApi("anthropic-messages"), false);
  assert.equal(isOpenAiCompletionsApi("ollama"), false);
});

test("isLocalBaseUrl flags localhost/127.0.0.1 but not remote https", () => {
  assert.equal(isLocalBaseUrl("http://localhost:11435"), true);
  assert.equal(isLocalBaseUrl("http://127.0.0.1:11434/v1"), true);
  assert.equal(isLocalBaseUrl("http://[::1]:8080/v1"), true);
  assert.equal(isLocalBaseUrl("https://api.kimi.com/coding/v1"), false);
  assert.equal(isLocalBaseUrl("https://localhostlookalike.com/v1"), false);
  assert.equal(isLocalBaseUrl(""), false);
});

test("listCredentialedProviders enumerates only fully-credentialed providers and resolves model id", () => {
  const config = {
    models: {
      providers: {
        kimi: { baseUrl: "https://api.kimi.com/coding/v1", apiKey: "sk-x", api: "openai-completions", models: [{ id: "kimi-for-coding" }, { id: "k3" }] },
        ollama: { baseUrl: "http://localhost:11435", apiKey: "local", api: "ollama", models: [{ id: "qwen" }] },
        nokey: { baseUrl: "https://x/v1", models: [{ id: "m" }] },              // no apiKey → excluded
        nomodel: { baseUrl: "https://y/v1", apiKey: "k", models: [] },          // no model → excluded
        nourl: { apiKey: "k", models: [{ id: "m" }] },                          // no baseUrl → excluded
        stringmodel: { baseUrl: "https://z/v1", apiKey: "k", models: ["bare-model"] }, // string model form, api unset
      },
    },
  };
  const out = listCredentialedProviders(config);
  const byId = Object.fromEntries(out.map((p) => [p.id, p]));
  assert.deepEqual(out.map((p) => p.id).sort(), ["kimi", "ollama", "stringmodel"]);
  assert.equal(byId.kimi.model, "kimi-for-coding"); // first model's id
  assert.equal(byId.kimi.api, "openai-completions");
  assert.equal(byId.kimi.isLocal, false);
  assert.equal(byId.ollama.api, "ollama"); // carried through so the suite can skip non-openai protocols
  assert.equal(byId.ollama.isLocal, true);
  assert.equal(byId.stringmodel.model, "bare-model"); // string form supported
  assert.equal(byId.stringmodel.api, ""); // unset → treated as OpenAI-compatible downstream
});

test("listCredentialedProviders is empty when providers absent", () => {
  assert.deepEqual(listCredentialedProviders({}), []);
  assert.deepEqual(listCredentialedProviders(null), []);
  assert.deepEqual(listCredentialedProviders({ models: {} }), []);
});

test("classifyProviderProbe: all formats ok -> pass with no code", () => {
  const provider = { id: "kimi", model: "kimi-for-coding", baseUrl: "https://api.kimi.com/coding/v1", isLocal: false };
  const results = PROBE_FORMATS.map((f) => ({ key: f.key, ok: true, status: 200, ms: 120, chars: 2 }));
  const out = classifyProviderProbe(provider, results);
  assert.equal(out.status, "pass");
  assert.equal(out.code, undefined);
  assert.match(out.evidence, /4\/4 formats/);
});

test("classifyProviderProbe: remote provider with any failing format -> fail E-MODEL-004", () => {
  const provider = { id: "ark-openai", model: "doubao", baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3", isLocal: false };
  const results = [
    { key: "plain", ok: false, status: 404, ms: 80, chars: 0, error: "does not support coding plan feature" },
    { key: "system+user", ok: false, status: 404, ms: 80, chars: 0, error: "does not support coding plan feature" },
    { key: "json", ok: false, status: 404, ms: 80, chars: 0, error: "x" },
    { key: "cjk", ok: false, status: 404, ms: 80, chars: 0, error: "x" },
  ];
  const out = classifyProviderProbe(provider, results);
  assert.equal(out.status, "fail");
  assert.equal(out.code, "E-MODEL-004");
  assert.match(out.evidence, /only 0\/4/);
});

test("classifyProviderProbe: local provider all-fail -> skip E-MODEL-SKIP (offline optional dep)", () => {
  const provider = { id: "ollama", model: "qwen", baseUrl: "http://localhost:11435", isLocal: true };
  const results = PROBE_FORMATS.map((f) => ({ key: f.key, ok: false, status: 0, ms: 5, chars: 0, error: "ECONNREFUSED" }));
  const out = classifyProviderProbe(provider, results);
  assert.equal(out.status, "skip");
  assert.equal(out.code, "E-MODEL-SKIP");
  assert.match(out.evidence, /local provider offline/);
});

test("classifyProviderProbe: local provider partially working -> fail (not a clean offline)", () => {
  const provider = { id: "ollama", model: "qwen", baseUrl: "http://localhost:11435", isLocal: true };
  const results = [
    { key: "plain", ok: true, status: 200, ms: 30, chars: 2 },
    { key: "system+user", ok: false, status: 500, ms: 30, chars: 0, error: "boom" },
    { key: "json", ok: true, status: 200, ms: 30, chars: 8 },
    { key: "cjk", ok: true, status: 200, ms: 30, chars: 1 },
  ];
  const out = classifyProviderProbe(provider, results);
  assert.equal(out.status, "fail"); // okCount>0 → not the "clean offline" skip path
  assert.equal(out.code, "E-MODEL-004");
});

test("probeProviderFormat: 2xx with content -> ok; non-2xx -> error; empty -> error; throw -> error", async () => {
  const origFetch = globalThis.fetch;
  try {
    // 2xx + content
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "OK" } }] }) });
    let r = await probeProviderFormat({ model: "m", baseUrl: "https://x/v1", apiKey: "k", messages: [{ role: "user", content: "hi" }] });
    assert.equal(r.ok, true);
    assert.equal(r.chars, 2);

    // non-2xx with provider error body
    globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({ error: { message: "model does not support coding plan feature" } }) });
    r = await probeProviderFormat({ model: "m", baseUrl: "https://x/v1", apiKey: "k", messages: [] });
    assert.equal(r.ok, false);
    assert.equal(r.status, 404);
    assert.match(r.error, /coding plan/);

    // 2xx, empty content BUT reasoning_content present -> ok (reasoning models return data there)
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "", reasoning_content: "let me think... OK" } }] }) });
    r = await probeProviderFormat({ model: "m", baseUrl: "https://x/v1", apiKey: "k", messages: [] });
    assert.equal(r.ok, true);
    assert.ok(r.chars > 0);

    // 2xx but truly empty (no content, no reasoning) -> error
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "" } }] }) });
    r = await probeProviderFormat({ model: "m", baseUrl: "https://x/v1", apiKey: "k", messages: [] });
    assert.equal(r.ok, false);
    assert.equal(r.error, "empty content");

    // network throw
    globalThis.fetch = async () => { throw new Error("ECONNREFUSED"); };
    r = await probeProviderFormat({ model: "m", baseUrl: "https://x/v1", apiKey: "k", messages: [] });
    assert.equal(r.ok, false);
    assert.match(r.error, /ECONNREFUSED/);

    // invalid baseUrl short-circuits without fetching
    r = await probeProviderFormat({ model: "m", baseUrl: "", apiKey: "k", messages: [] });
    assert.equal(r.ok, false);
    assert.equal(r.error, "invalid baseUrl");
  } finally {
    globalThis.fetch = origFetch;
  }
});

// ── ② 全链路实例：纯信号映射 ──────────────────────────────────────────────────

test("buildModelProbeAgentId mints model-probe-<slug> with only [a-z0-9-]", () => {
  assert.equal(buildModelProbeAgentId("kimi"), "model-probe-kimi");
  assert.equal(buildModelProbeAgentId("ark-openai"), "model-probe-ark-openai");
  assert.equal(buildModelProbeAgentId("GLM_BigModel.v2"), "model-probe-glm-bigmodel-v2");
  assert.equal(buildModelProbeAgentId("--weird--"), "model-probe-weird");
  assert.equal(buildModelProbeAgentId(""), "model-probe-provider"); // degenerate input still yields a legal id
  assert.ok(buildModelProbeAgentId("x").startsWith(MODEL_PROBE_AGENT_PREFIX));
});

test("shouldRunModelE2e: remote providers always run, regardless of API-leg status", () => {
  const remote = { id: "ark-anthropic", isLocal: false };
  assert.equal(shouldRunModelE2e(remote, "pass").run, true);
  assert.equal(shouldRunModelE2e(remote, "fail").run, true); // e2e is independent signal for remote
  assert.equal(shouldRunModelE2e(remote, "skip").run, true); // protocol-skipped remote gets its only coverage here
});

test("shouldRunModelE2e: local providers gate on an API-leg pass (offline dep must not burn the budget)", () => {
  const local = { id: "ollama", isLocal: true };
  assert.equal(shouldRunModelE2e(local, "pass").run, true);
  const skipped = shouldRunModelE2e(local, "skip");
  assert.equal(skipped.run, false);
  assert.match(skipped.evidence, /ollama/);
  assert.match(skipped.evidence, /e2e skipped/);
  assert.equal(shouldRunModelE2e(local, "fail").run, false);
});

test("classifyModelE2eOutcome: timeout -> fail E-MODEL-005 with budget + lastStatus in evidence", () => {
  const provider = { id: "kimi", model: "kimi-for-coding" };
  const out = classifyModelE2eOutcome(provider, {
    status: null, timedOut: true, lastStatus: "running", deliverableText: null, deliverablePath: null, latencyMs: MODEL_E2E_BUDGET_MS,
  });
  assert.equal(out.status, "fail");
  assert.equal(out.code, "E-MODEL-005");
  assert.match(out.evidence, new RegExp(`${MODEL_E2E_BUDGET_MS}ms`));
  assert.match(out.evidence, /lastStatus=running/);
});

test("classifyModelE2eOutcome: completed with MODEL_OK deliverable -> pass carrying latency", () => {
  const provider = { id: "kimi", model: "kimi-for-coding" };
  const out = classifyModelE2eOutcome(provider, {
    status: "completed", timedOut: false, lastStatus: "completed",
    deliverableText: `probe done\n${MODEL_OK_MARKER}\n`, deliverablePath: "/tmp/DIRECT-x.md", latencyMs: 41230,
  });
  assert.equal(out.status, "pass");
  assert.equal(out.code, undefined);
  assert.match(out.evidence, /kimi\/kimi-for-coding/);
  assert.match(out.evidence, /41230ms/);
  assert.match(out.evidence, /MODEL_OK/);
});

test("classifyModelE2eOutcome: completed without the marker -> fail E-MODEL-005", () => {
  const provider = { id: "glm-bigmodel", model: "glm-5.1" };
  const out = classifyModelE2eOutcome(provider, {
    status: "completed", timedOut: false, lastStatus: "completed",
    deliverableText: "wrote something else entirely", deliverablePath: "/tmp/DIRECT-y.md", latencyMs: 9000,
  });
  assert.equal(out.status, "fail");
  assert.equal(out.code, "E-MODEL-005");
  assert.match(out.evidence, /missing MODEL_OK/);
});

test("classifyModelE2eOutcome: unreadable deliverable on completion -> fail with 'no readable output'", () => {
  const provider = { id: "kimi", model: "kimi-for-coding" };
  const out = classifyModelE2eOutcome(provider, {
    status: "completed", timedOut: false, lastStatus: "completed",
    deliverableText: null, deliverablePath: null, latencyMs: 5000,
  });
  assert.equal(out.status, "fail");
  assert.equal(out.code, "E-MODEL-005");
  assert.match(out.evidence, /no readable output/);
});

test("classifyModelE2eOutcome: non-completed terminal status -> fail E-MODEL-005 with the status", () => {
  const provider = { id: "cherry-nvidia", model: "meta/llama-3.2-1b-instruct" };
  for (const status of ["failed", "abandoned", "cancelled"]) {
    const out = classifyModelE2eOutcome(provider, {
      status, timedOut: false, lastStatus: status, deliverableText: null, deliverablePath: null, latencyMs: 12000,
    });
    assert.equal(out.status, "fail");
    assert.equal(out.code, "E-MODEL-005");
    assert.match(out.evidence, new RegExp(`ended ${status}`));
  }
});

test("probe task instructs the file-write tool and embeds the marker verbatim", () => {
  assert.match(MODEL_PROBE_TASK, /文件写入工具/);
  assert.ok(MODEL_PROBE_TASK.includes(MODEL_OK_MARKER));
  assert.equal(MODEL_E2E_BUDGET_MS, 180000); // 设计定值：每模型 180s 预算
});

test("buildHostRosterSkipEvidence: names the model ref, the gate budget, and the host constraint", () => {
  const provider = { id: "kimi", model: "kimi-for-coding" };
  const evidence = buildHostRosterSkipEvidence(provider);
  assert.match(evidence, /kimi\/kimi-for-coding/);
  assert.match(evidence, /boot-frozen/);
  assert.match(evidence, new RegExp(`${MODEL_E2E_BIRTH_GATE_MS / 1000}s`));
  assert.equal(MODEL_E2E_BIRTH_GATE_MS, 25000); // 设计定值：出生门 25s，远小于 180s 全预算
});
