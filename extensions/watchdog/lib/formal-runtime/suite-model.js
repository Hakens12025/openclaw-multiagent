// lib/formal-runtime/suite-model.js — 模型套件（裸 API 连通 + 全链路实例；吸收原 suite-providers.js）
//
// 每个「有凭证」的 provider（models.providers 里 baseUrl+apiKey+models[0] 齐全者）两步判定：
//   ① model.<provider>-api — 裸 API 连通（原 providers 套件逻辑原样吸收）：
//      多格式小请求（纯文本 / 带 system / 要求 JSON / 中文）打 chat/completions，
//      远端任一格式不通 → fail E-MODEL-004；本地(localhost)全失败 → skip E-MODEL-SKIP；
//      非 openai-completions 协议（anthropic-messages / ollama 原生）→ skip（不能用错协议打假 404）。
//   ② model.<provider>-e2e — 全链路实例：创建临时 executor agent（id model-probe-<slug>，
//      model 绑 <provider>/<models[0]>）→ 直派原语派极简写文件任务（createDirectRequestEnvelope +
//      deliveryEnqueueSystemActionReturn，不经 ingress、不动 graph）→ 轮询 /watchdog/work-items
//      到合约终态。判定：completed 且交付物含 MODEL_OK → pass（evidence 带注入→终态延迟）；
//      failed/超时/缺标记 → fail E-MODEL-005；临时 agent 建/删失败 → E-MODEL-006
//      （删失败单独出 model.<provider>-cleanup fail check，绝不静默残留）。
//
// 串行逐模型（防限流）；每模型 e2e 预算 180s，超时 terminalize 清场后 fail。
// 本地 provider 的 e2e 只在 ① pass 时才跑（离线本地依赖不烧 180s 预算，跟随 ① 的 skip 语义）。
//
// 探针都是普通 chat/completions（不用 response_format 等非通用 API），temperature 省略
// （Kimi coding 只接受 temperature==1；省略让各 provider 用自身默认，与 llm-planner FIX(kimi-temp) 同策）。
// reasoning 模型（kimi）可见 content 可能为空、输出在 reasoning_content——两者任一非空即视为「返回了数据」。
//
// 临时 agent 生命周期走正规路径 agent-admin-create-delete.js（saveConfig 即时
// registerRuntimeAgents + syncDispatchTargets，无需重启网关）；平台没有自动回收
// （withPreservedRuntimeGraph 不还原 agents.list），所以 finally 里 hardDelete 是硬义务。
// 变更（admin/协议/投递）栈全部惰性 import：与 test-run-suites.js 同理，避免把
// admin-surface-operations 链焊进启动期环，同时让 tests/suite-model-units.test.js 保持零 IO。

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { markBlocked, runCheck } from "./checks/check-runner.js";
import { buildChatCompletionsUrl, extractAssistantText } from "../llm/llm-planner.js";
import { fetchJSON, loadConfig, postAdmin, sleep, wakeAgentNow } from "./infra.js";
import { readContractSnapshotById } from "../contract/contracts.js";
import { resolveRuntimeResultOutputPath } from "../routing/delivery/delivery-result.js";
import { CONTRACT_STATUS, isCompletedContractStatus, isTerminalContractStatus } from "../core/runtime-status.js";

const CONFIG_FILE = join(homedir(), ".openclaw", "openclaw.json");
const PROBE_TIMEOUT_MS = 20000;
// 512 not 24: reasoning models (kimi-for-coding) spend budget on reasoning tokens before emitting
// visible content; a tiny budget leaves content empty (finish_reason=length) → false negative even
// though the provider is up (verified: kimi passes real dispatch). 512 gives headroom for a short answer.
const PROBE_MAX_TOKENS = 512;

// ── ② 全链路实例：常量与纯逻辑 ────────────────────────────────────────────────

export const MODEL_OK_MARKER = "MODEL_OK";
export const MODEL_E2E_BUDGET_MS = 180000;
export const MODEL_PROBE_AGENT_PREFIX = "model-probe-";
// 极简确定性任务：唯一动作 = 用文件写入工具把标记写进合约输出文件。
export const MODEL_PROBE_TASK = "连通性探针任务：请使用文件写入工具，把一行 MODEL_OK 写入本任务指定的输出文件，然后立即结束。不要做任何其他事情。";

const E2E_POLL_INTERVAL_MS = 2000;

// 出生门：动态建的 agent 派发后,合约必须在此预算内被观察到进入 running/终态
// (= 宿主为它诞生过会话)。2026-08-12 实测:宿主内嵌 runtime 花名册启动时固定,
// 动态 agent 唤醒静默无效——不设此门,每个模型白烧满 180s 预算。
export const MODEL_E2E_BIRTH_GATE_MS = 25000;

// 纯函数:宿主花名册不支持时的 skip 证词(首个模型探出后,其余模型复用)。
export function buildHostRosterSkipEvidence(provider, gateMs = MODEL_E2E_BIRTH_GATE_MS) {
  return `host runtime roster is boot-frozen: dynamically created agent for ${provider.id}/${provider.model} `
    + `never spawned a session within ${gateMs / 1000}s — per-model e2e needs host support for dynamic agent wake; `
    + `the API leg already covers connectivity`;
}

// 纯函数：provider id → 临时 agent id（model-probe-<slug>；slug 只留 [a-z0-9-]）。
export function buildModelProbeAgentId(providerId) {
  const slug = String(providerId || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${MODEL_PROBE_AGENT_PREFIX}${slug || "provider"}`;
}

// 纯函数：e2e 门控。远端 provider 无条件跑（协议 skip 的远端正好靠 e2e 补覆盖）；
// 本地 provider 只在 ① pass 后才跑——离线本地依赖跟随 ① 的 skip 语义，不烧 180s 预算。
export function shouldRunModelE2e(provider, apiStatus) {
  if (!provider?.isLocal) return { run: true };
  if (apiStatus === "pass") return { run: true };
  return {
    run: false,
    evidence: `local provider ${provider.id} not confirmed reachable by the API leg (${apiStatus || "unknown"}) — `
      + `e2e skipped instead of burning the ${MODEL_E2E_BUDGET_MS / 1000}s budget; start the local endpoint to enable it`,
  };
}

// 纯函数：把一次 e2e 观测判成 CheckResult 载荷（单测喂 canned 观测）。
// observation: { status, timedOut, lastStatus, deliverableText, deliverablePath, latencyMs }
export function classifyModelE2eOutcome(provider, observation) {
  const head = `${provider.id}/${provider.model}`;
  const latency = `${Math.round(observation.latencyMs ?? 0)}ms`;
  if (observation.timedOut) {
    return {
      status: "fail",
      code: "E-MODEL-005",
      evidence: `${head}: no terminal contract status within ${MODEL_E2E_BUDGET_MS}ms budget `
        + `(lastStatus=${observation.lastStatus || "never-seen"}); contract terminalized for cleanup`,
    };
  }
  if (!isCompletedContractStatus(observation.status)) {
    return {
      status: "fail",
      code: "E-MODEL-005",
      evidence: `${head}: contract ended ${observation.status || "unknown"} after ${latency} (dispatch→terminal)`,
    };
  }
  const text = typeof observation.deliverableText === "string" ? observation.deliverableText : "";
  if (!text.includes(MODEL_OK_MARKER)) {
    return {
      status: "fail",
      code: "E-MODEL-005",
      evidence: `${head}: completed in ${latency} but deliverable missing ${MODEL_OK_MARKER} marker `
        + `(${observation.deliverablePath || "no readable output"})`,
    };
  }
  return {
    status: "pass",
    evidence: `${head}: dispatch→completed in ${latency}; deliverable carries ${MODEL_OK_MARKER} (${observation.deliverablePath})`,
  };
}

// ── ① 裸 API 连通（原 suite-providers.js 逻辑，原样吸收）────────────────────────

// 多格式小请求：纯文本 / 带 system / 要求 JSON / 中文（测 UTF-8 往返）。
export const PROBE_FORMATS = Object.freeze([
  { key: "plain", messages: [{ role: "user", content: "Reply with exactly: OK" }] },
  {
    key: "system+user",
    messages: [
      { role: "system", content: "You are a connectivity probe. Answer tersely." },
      { role: "user", content: "Reply with exactly: OK" },
    ],
  },
  { key: "json", messages: [{ role: "user", content: 'Return only this JSON and nothing else: {"ok":true}' }] },
  { key: "cjk", messages: [{ role: "user", content: "用一个字回复：好" }] },
]);

// localhost/127.0.0.1 = 本地可选依赖 → 离线记 skip 而非 fail。
export function isLocalBaseUrl(baseUrl) {
  const s = String(baseUrl || "").toLowerCase();
  return /\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?:[:/]|$)/.test(s);
}

// 探针只会 OpenAI chat/completions；其它协议（anthropic-messages / ollama 原生）不能用这条路径探，
// 明确 skip 而非用错协议打出假 404。api 未设 = 按 OpenAI 兼容默认对待（向后兼容）。
export function isOpenAiCompletionsApi(api) {
  const a = String(api || "").trim().toLowerCase();
  return a === "" || a === "openai-completions" || a === "openai";
}

// 纯函数：从 config 枚举有凭证（baseUrl + apiKey + 至少一个 model）的 provider（单测直接喂 config）。
export function listCredentialedProviders(config) {
  const providers = config?.models?.providers;
  if (!providers || typeof providers !== "object") return [];
  const out = [];
  for (const [id, raw] of Object.entries(providers)) {
    const baseUrl = raw?.baseUrl || raw?.base_url || "";
    const apiKey = raw?.apiKey || raw?.api_key || "";
    const api = raw?.api || raw?.type || "";
    const models = Array.isArray(raw?.models) ? raw.models : [];
    const first = models[0];
    const model = typeof first === "string" ? first : (first?.id || first?.name || "");
    if (!baseUrl || !apiKey || !model) continue; // 无凭证 / 无 baseUrl / 无 model → 不可探
    out.push({ id, baseUrl, apiKey, api, model, isLocal: isLocalBaseUrl(baseUrl) });
  }
  return out;
}

// 纯函数：把一组 format 探测结果判定成一条 CheckResult 载荷（单测喂 canned 结果）。
// formatResults: [{ key, ok, status, ms, chars, error }]
export function classifyProviderProbe(provider, formatResults) {
  const total = formatResults.length;
  const okCount = formatResults.filter((r) => r.ok).length;
  const detail = formatResults
    .map((r) => (r.ok
      ? `${r.key}✓(${r.chars}c/${r.ms}ms)`
      : `${r.key}✗(${r.status || "ERR"}:${String(r.error || "").slice(0, 60)})`))
    .join(" ");
  const head = `${provider.model} @ ${provider.baseUrl}`;
  if (okCount === total) {
    return { status: "pass", evidence: `${head}: ${okCount}/${total} formats returned data — ${detail}` };
  }
  if (provider.isLocal && okCount === 0) {
    return { status: "skip", code: "E-MODEL-SKIP", evidence: `local provider offline: ${head} — ${detail}` };
  }
  return {
    status: "fail",
    code: "E-MODEL-004",
    evidence: `${head}: only ${okCount}/${total} formats returned data — ${detail}`,
  };
}

// LIVE：单个 format 探测（mock globalThis.fetch 可单测）。永不抛，失败归一成结构化结果。
export async function probeProviderFormat({ model, baseUrl, apiKey, messages, timeoutMs = PROBE_TIMEOUT_MS }) {
  const endpoint = buildChatCompletionsUrl(baseUrl);
  if (!endpoint) return { ok: false, status: 0, ms: 0, chars: 0, error: "invalid baseUrl" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, max_tokens: PROBE_MAX_TOKENS, messages }),
      signal: controller.signal,
    });
    const ms = Date.now() - startedAt;
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      return { ok: false, status: response.status, ms, chars: 0, error: payload?.error?.message || payload?.message || `http ${response.status}` };
    }
    // 可见 content 优先；reasoning 模型可能把输出放在 reasoning_content（content 空但 provider 确实回了数据）。
    const content = extractAssistantText(payload);
    const reasoning = typeof payload?.choices?.[0]?.message?.reasoning_content === "string"
      ? payload.choices[0].message.reasoning_content : "";
    const chars = content ? content.length : reasoning.length;
    if (!chars) return { ok: false, status: response.status, ms, chars: 0, error: "empty content" };
    return { ok: true, status: response.status, ms, chars };
  } catch (error) {
    const ms = Date.now() - startedAt;
    const aborted = error?.name === "AbortError";
    return { ok: false, status: 0, ms, chars: 0, error: aborted ? `timeout ${timeoutMs}ms` : (error?.message || String(error)) };
  } finally {
    clearTimeout(timer);
  }
}

// ── ② 全链路实例：IO 腿 ───────────────────────────────────────────────────────

// 出生观察:合约进入 running 或任一终态 = 宿主为该 agent 诞生过会话。
async function waitForDirectContractBirth(contractId, deadlineMs) {
  let lastStatus = null;
  while (Date.now() < deadlineMs) {
    try {
      const items = await fetchJSON("/watchdog/work-items");
      const item = (Array.isArray(items) ? items : []).find((entry) => entry.id === contractId);
      if (item?.status) {
        lastStatus = item.status;
        if (item.status === "running" || isTerminalContractStatus(item.status)) {
          return { born: true, lastStatus };
        }
      }
    } catch { /* 网关瞬断 → 下一轮重试 */ }
    await sleep(E2E_POLL_INTERVAL_MS);
  }
  return { born: false, lastStatus };
}

// 轮询 /watchdog/work-items 等 DIRECT 合约终态（固定 180s 预算，进度显示交给 run 字段）。
async function waitForDirectContractTerminal(contractId, deadlineMs) {
  let lastStatus = null;
  while (Date.now() < deadlineMs) {
    try {
      const items = await fetchJSON("/watchdog/work-items");
      const item = (Array.isArray(items) ? items : []).find((entry) => entry.id === contractId);
      if (item?.status) {
        lastStatus = item.status;
        if (isTerminalContractStatus(item.status)) {
          return { status: item.status, timedOut: false, lastStatus };
        }
      }
    } catch { /* 网关瞬断 → 下一轮重试，预算封顶 */ }
    await sleep(E2E_POLL_INTERVAL_MS);
  }
  return { status: null, timedOut: true, lastStatus };
}

// 读交付物：共享合约快照的 output 投影优先（v133 镜像回归点同源），回落 direct envelope 自带路径。
async function readModelDeliverable(contractEnvelope) {
  let snapshot = null;
  try { snapshot = await readContractSnapshotById(contractEnvelope.id); } catch { /* 快照缺失 → 走回落 */ }
  const candidates = [
    snapshot ? resolveRuntimeResultOutputPath(snapshot) : null,
    contractEnvelope.output || null,
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      return { text: await readFile(candidate, "utf8"), path: candidate };
    } catch { /* 试下一个候选 */ }
  }
  return { text: null, path: null };
}

// 单模型全链路：临时 agent → 直派 → 终态 → 交付物判定；finally 硬删（含 workspace）。
async function runModelE2eCase(context, provider, hostGate = null) {
  const agentId = buildModelProbeAgentId(provider.id);
  const modelRef = `${provider.id}/${provider.model}`;
  const descriptor = {
    id: `model.${provider.id}-e2e`,
    subsystem: "model",
    title: `Model ${modelRef} completes a dispatched file-write task end to end`,
    code: "E-MODEL-005",
  };

  // 变更栈惰性 import（见文件头：启动环 + 单测零 IO 双重理由）。
  // admin 模块引用留在闭包：import 失败也走 runCheck 捕获成 fail check，suite 顶层永不抛。
  let admin = null;
  let created = false;

  try {
    await runCheck(context, descriptor, async () => {
      admin = await import("../agent/admin/agent-admin-create-delete.js");
      const [{ createDirectRequestEnvelope }, transport, { SYSTEM_ACTION_DELIVERY_IDS }, wakeTransport, { agentWorkspace }, contractLineage] = await Promise.all([
        import("../protocol/protocol-primitives.js"),
        import("../routing/delivery/delivery-system-action-transport.js"),
        import("../routing/delivery/delivery-protocols.js"),
        import("../transport/runtime-wake-transport.js"),
        import("../state.js"),
        import("../contract/contract-lineage.js"),
      ]);

      // 临时 agent：正规创建路径（executor 能力预设自带 write 工具面），失败 = 生命周期码。
      try {
        await admin.createAgentDefinition({ id: agentId, model: modelRef, role: "executor" });
        created = true;
      } catch (error) {
        return {
          status: "fail",
          code: "E-MODEL-006",
          evidence: `temp agent create failed for ${agentId} (model=${modelRef}): ${error?.message || error}`,
        };
      }

      // 直派（不经 ingress、不动 graph）：与 assign_task worker 腿同一原语面。
      const contract = createDirectRequestEnvelope({
        agentId,
        sessionKey: `agent:${agentId}:main`,
        replyTo: null, // 探针不需要回程腿；终态由轮询判定
        // 批① 谱系:探针直派绕过 ingress,是触发点 —— 就地铸新线新 run(无会话种子=随机线)。
        lineage: contractLineage.buildLineage({
          threadId: contractLineage.mintThreadId(),
          runId: contractLineage.mintRunId(),
        }),
        message: MODEL_PROBE_TASK,
        outputDir: join(agentWorkspace(agentId), "output"),
        source: "direct_intake",
      });
      const startedAt = Date.now();
      const { wake, enqueueResult } = await transport.deliveryEnqueueSystemActionReturn({
        deliveryLeg: "dispatch",
        lane: SYSTEM_ACTION_DELIVERY_IDS.ASSIGN_TASK_RESULT,
        targetAgent: agentId,
        contract,
        logger: console,
        wake: {
          reason: wakeTransport.buildRuntimeWakeReason(null, {
            wakeSemantic: wakeTransport.RUNTIME_WAKE_SEMANTICS.ASSIGN_TASK_DISPATCH,
            sourceAgentId: "formal-model-suite",
          }),
          wakeSemantic: wakeTransport.RUNTIME_WAKE_SEMANTICS.ASSIGN_TASK_DISPATCH,
          sourceAgentId: "formal-model-suite",
        },
      });
      // 新建 agent 应当空闲即投递即唤醒；任一环节没确认就用 hook 唤醒兜底（幂等）。
      if (!enqueueResult?.promoted || wake?.ok === false) {
        try { await wakeAgentNow(agentId, "处理当前协作任务。"); } catch { /* 兜底失败由终态轮询裁决 */ }
      }

      // 出生门:预算内会话未诞生 = 宿主花名册不含动态 agent → skip 并短路后续模型,
      // 搁浅合约就地 terminalize 清场。
      const birth = await waitForDirectContractBirth(contract.id, startedAt + MODEL_E2E_BIRTH_GATE_MS);
      if (!birth.born) {
        if (hostGate) hostGate.supported = false;
        try {
          await postAdmin("/watchdog/tests/terminalize", {
            contractId: contract.id,
            status: CONTRACT_STATUS.FAILED,
            source: "test_runner",
            reason: "model_e2e_host_roster",
            summary: `no session born for dynamic agent ${agentId} within ${MODEL_E2E_BIRTH_GATE_MS}ms`,
            retryable: false,
          });
        } catch { /* 清场尽力而为 */ }
        return {
          status: "skip",
          code: "E-MODEL-SKIP",
          evidence: buildHostRosterSkipEvidence(provider),
        };
      }
      if (hostGate) hostGate.supported = true;

      const outcome = await waitForDirectContractTerminal(contract.id, startedAt + MODEL_E2E_BUDGET_MS);
      if (outcome.timedOut) {
        try {
          await postAdmin("/watchdog/tests/terminalize", {
            contractId: contract.id,
            status: CONTRACT_STATUS.FAILED,
            source: "test_runner",
            reason: "model_e2e_timeout",
            summary: `model suite e2e probe for ${modelRef} exceeded ${MODEL_E2E_BUDGET_MS}ms`,
            retryable: false,
          });
        } catch { /* 清场尽力而为；判定不依赖它 */ }
      }

      let deliverable = { text: null, path: null };
      if (isCompletedContractStatus(outcome.status)) {
        deliverable = await readModelDeliverable(contract);
      }
      return classifyModelE2eOutcome(provider, {
        status: outcome.status,
        timedOut: outcome.timedOut,
        lastStatus: outcome.lastStatus,
        deliverableText: deliverable.text,
        deliverablePath: deliverable.path,
        latencyMs: Date.now() - startedAt,
      });
    });
  } finally {
    // 硬义务：临时 agent 绝不残留（含 workspace）。失败单独出 fail check（collab cleanup 风格）。
    if (created && admin) {
      try {
        await admin.hardDeleteAgentDefinition({ agentId });
      } catch (error) {
        context.addCheck({
          id: `model.${provider.id}-cleanup`,
          subsystem: "model",
          title: `Temp probe agent ${agentId} removed after e2e`,
          status: "fail",
          code: "E-MODEL-006",
          evidence: `hard delete failed: ${error?.message || error}; remove ${agentId} from agents.list `
            + `+ workspaces/${agentId}/ manually (no automatic reclaim)`,
          durationMs: 0,
        });
      }
    }
  }
}

// ── suite 驱动 ────────────────────────────────────────────────────────────────

export async function runModelSuite(run, context) {
  let config = null;
  try {
    config = JSON.parse(await readFile(CONFIG_FILE, "utf8"));
  } catch (error) {
    context.addCheck({
      id: "model.config", subsystem: "model", title: "openclaw.json readable for model enumeration",
      status: "fail", code: "E-CONFIG-001", evidence: `config unreadable: ${error?.message || error}`, durationMs: 0,
    });
    return;
  }

  const providers = listCredentialedProviders(config);
  if (providers.length === 0) {
    context.addCheck({
      id: "model.enumerate", subsystem: "model", title: "Credentialed providers available to probe",
      status: "skip", code: "E-MODEL-SKIP", evidence: "no credentialed provider found in models.providers", durationMs: 0,
    });
    return;
  }

  // e2e 腿的网关前置（轮询/terminalize/兜底唤醒走 HTTP 面）；不可达时 ① 照跑、② 全 blocked。
  let gatewayReady = true;
  let gatewayError = "";
  try {
    await loadConfig();
    await fetchJSON("/watchdog/runtime");
  } catch (error) {
    gatewayReady = false;
    gatewayError = error?.message || String(error);
  }

  const hostGate = { supported: null };
  for (const provider of providers) {
    const modelRef = `${provider.id}/${provider.model}`;
    if (run && typeof run === "object") {
      run.currentCaseId = provider.id;
      run.currentCaseMessage = `model:${modelRef}`;
    }

    // ① 裸 API 连通
    let apiStatus;
    if (!isOpenAiCompletionsApi(provider.api)) {
      // 非 openai-completions 协议不能用 chat/completions 探针 → 明确 skip。
      apiStatus = context.addCheck({
        id: `model.${provider.id}-api`, subsystem: "model",
        title: `Provider ${provider.id} returns data across probe formats`,
        status: "skip", code: "E-MODEL-SKIP",
        evidence: `api="${provider.api}" not probeable: the connectivity probe speaks OpenAI chat/completions only — add an adapter (anthropic-messages / ollama) to cover this provider`,
        durationMs: 0,
      }).status;
    } else {
      const apiCheck = await runCheck(context, {
        id: `model.${provider.id}-api`,
        subsystem: "model",
        title: `Provider ${provider.id} returns data across probe formats`,
        code: "E-MODEL-004",
      }, async () => {
        const formatResults = await Promise.all(
          PROBE_FORMATS.map(async (fmt) => ({ key: fmt.key, ...(await probeProviderFormat({
            model: provider.model, baseUrl: provider.baseUrl, apiKey: provider.apiKey, messages: fmt.messages,
          })) })),
        );
        return classifyProviderProbe(provider, formatResults);
      });
      apiStatus = apiCheck.status;
    }

    // ② 全链路实例
    const gate = shouldRunModelE2e(provider, apiStatus);
    const e2eDescriptor = {
      id: `model.${provider.id}-e2e`, subsystem: "model",
      title: `Model ${modelRef} completes a dispatched file-write task end to end`,
    };
    if (!gate.run) {
      context.addCheck({ ...e2eDescriptor, status: "skip", code: "E-MODEL-SKIP", evidence: gate.evidence, durationMs: 0 });
      continue;
    }
    if (!gatewayReady) {
      markBlocked(context, [e2eDescriptor], "E-RUNNER-003", `gateway prerequisite failed: ${gatewayError}`);
      continue;
    }
    if (hostGate.supported === false) {
      context.addCheck({
        ...e2eDescriptor, status: "skip", code: "E-MODEL-SKIP",
        evidence: buildHostRosterSkipEvidence(provider), durationMs: 0,
      });
      continue;
    }
    await runModelE2eCase(context, provider, hostGate);
  }
}
