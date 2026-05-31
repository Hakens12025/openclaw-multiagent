import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

function fileUrl(relativePath) {
  return new URL(relativePath, import.meta.url);
}

test("control-plane consumers use dispatch-runtime-state instead of raw legacy state globals", async () => {
  const expectations = [
    {
      filePath: fileUrl("../lib/routing/dispatch-graph-policy.js"),
      forbidden: [/import\s*\{\s*workerPool\s*\}\s*from "\.\.\/state\.js"/],
      required: [/from "\.\/dispatch-runtime-state\.js"/],
    },
    {
      filePath: fileUrl("../lib/ingress/dispatch-execution-contract-entry.js"),
      forbidden: [
        /import\s*\{[\s\S]*\bworkerPool\b[\s\S]*\}\s*from "\.\.\/state\.js"/,
      ],
      required: [/from "\.\.\/routing\/dispatch-runtime-state\.js"/],
    },
    {
      filePath: fileUrl("../lib/lifecycle/runtime-lifecycle.js"),
      forbidden: [
        /import\s*\{[\s\S]*\bworkerPool\b[\s\S]*\}\s*from "\.\.\/state\.js"/,
      ],
      required: [/from "\.\.\/routing\/dispatch-runtime-state\.js"/],
    },
    {
      // P-D.2 收口：api.js 不再直接 import dispatch-runtime-state，
      // 改为经 CLI-system inspect.runtime_state surface 读取 dispatch runtime
      // （cli-runtime-inspector 内部仍走 dispatch-runtime-state，真值边界唯一）。
      // forbidden 规则（不读 raw legacy state globals）仍然成立。
      filePath: fileUrl("../routes/api.js"),
      forbidden: [
        /import\s*\{[\s\S]*\btaskQueue\b[\s\S]*\}\s*from "\.\.\/lib\/state\.js"/,
        /import\s*\{[\s\S]*\bworkerPool\b[\s\S]*\}\s*from "\.\.\/lib\/state\.js"/,
      ],
      required: [/from "\.\.\/lib\/cli-system\/cli-surface-registry\.js"/, /inspect\.runtime_state/],
    },
    {
      // P-D.2 收口：边界上移后，cli-runtime-inspector 成为 dispatch runtime 真值读取的
      // 唯一新边界（inspect.runtime_state 的 source）。它必须经 dispatch-runtime-state 正源，
      // 同样禁止读 raw legacy state globals —— 把守随边界一起上移，保护不留缺口。
      filePath: fileUrl("../lib/cli-system/cli-runtime-inspector.js"),
      forbidden: [
        /import\s*\{[\s\S]*\btaskQueue\b[\s\S]*\}\s*from "\.\.\/state\.js"/,
        /import\s*\{[\s\S]*\bworkerPool\b[\s\S]*\}\s*from "\.\.\/state\.js"/,
      ],
      required: [/from "\.\.\/routing\/dispatch-runtime-state\.js"/],
    },
  ];

  for (const expectation of expectations) {
    const content = await readFile(expectation.filePath, "utf8");
    for (const pattern of expectation.forbidden) {
      assert.doesNotMatch(content, pattern, `${expectation.filePath} still imports raw legacy dispatch globals`);
    }
    for (const pattern of expectation.required) {
      assert.match(content, pattern, `${expectation.filePath} should use dispatch-runtime-state api`);
    }
  }
});

test("operator runtime snapshot consumes canonical CLI runtime dispatch snapshot instead of raw legacy state globals", async () => {
  const source = await readFile(
    fileUrl("../lib/operator/operator-snapshot-runtime.js"),
    "utf8",
  );

  assert.doesNotMatch(
    source,
    /import\s*\{[\s\S]*\btaskQueue\b[\s\S]*\}\s*from "\.\.\/state\.js"/,
    "operator runtime snapshot should not import raw taskQueue",
  );
  assert.doesNotMatch(
    source,
    /import\s*\{[\s\S]*\bworkerPool\b[\s\S]*\}\s*from "\.\.\/state\.js"/,
    "operator runtime snapshot should not import raw workerPool",
  );
  assert.match(
    source,
    /from "\.\.\/cli-system\/cli-runtime-inspector\.js"/,
    "operator runtime snapshot should consume the CLI runtime inspector boundary",
  );
  assert.match(
    source,
    /inspectCliRuntimeState\(\)/,
    "operator runtime snapshot should derive runtime state through the inspector",
  );
  assert.match(
    source,
    /runtimeState\.dispatchRuntime/,
    "operator runtime snapshot should read canonical dispatch runtime payload from the inspector",
  );
});

test("dispatch-runtime-state stays side-effect light while session edges own QQ notifications", async () => {
  const dispatchStateSource = await readFile(
    fileUrl("../lib/routing/dispatch-runtime-state.js"),
    "utf8",
  );
  const sessionBootstrapSource = await readFile(
    fileUrl("../lib/session-bootstrap.js"),
    "utf8",
  );
  const runtimeLifecycleSource = await readFile(
    fileUrl("../lib/lifecycle/runtime-lifecycle.js"),
    "utf8",
  );

  assert.doesNotMatch(
    dispatchStateSource,
    /from "\.\.\/qq\.js"/,
    "dispatch-runtime-state should not own QQ side effects",
  );
  assert.doesNotMatch(
    dispatchStateSource,
    /readCachedContractSnapshotById|getContractPath/,
    "dispatch-runtime-state should not read contracts to perform side effects",
  );
  assert.match(
    sessionBootstrapSource,
    /from "\.\/channel-notify\.js"/,
    "session-bootstrap should send dispatch-start QQ notifications through channel-notify",
  );
  assert.match(
    runtimeLifecycleSource,
    /from "\.\.\/channel-notify\.js"/,
    "runtime-lifecycle should send release-time QQ notifications through channel-notify",
  );
});

test("dispatch runtime snapshot consumers read canonical targets shape instead of legacy workers shape", async () => {
  const indexSource = await readFile(
    fileUrl("../index.js"),
    "utf8",
  );
  const operatorSnapshotSource = await readFile(
    fileUrl("../lib/operator/operator-snapshot-runtime.js"),
    "utf8",
  );
  const ingressEntrySource = await readFile(
    fileUrl("../lib/ingress/dispatch-execution-contract-entry.js"),
    "utf8",
  );

  assert.doesNotMatch(
    indexSource,
    /runtimeSnapshot\.workers/,
    "watchdog index should read canonical targets shape",
  );
  assert.doesNotMatch(
    operatorSnapshotSource,
    /snapshot\.workers|runtimeSnapshot\.workers/,
    "operator runtime snapshot should read canonical targets shape",
  );
  assert.doesNotMatch(
    ingressEntrySource,
    /runtimeSnapshot\.workers/,
    "ingress receipt should read canonical targets shape",
  );
  assert.match(
    indexSource,
    /runtimeSnapshot\.targets/,
    "watchdog index should read canonical targets payload",
  );
  assert.match(
    operatorSnapshotSource,
    /snapshot\.targets|runtimeSnapshot\.targets/,
    "operator runtime snapshot should read canonical targets payload",
  );
  assert.match(
    ingressEntrySource,
    /listDispatchTargetIds/,
    "ingress receipt should use canonical dispatch target id API",
  );
});

test("active runtime agent config consumers use agent-identity instead of the raw runtimeAgentConfigs map", async () => {
  const indexSource = await readFile(
    fileUrl("../index.js"),
    "utf8",
  );
  const apiRouteSource = await readFile(
    fileUrl("../routes/api.js"),
    "utf8",
  );
  const handlerRegistrySource = await readFile(
    fileUrl("../lib/routing/runtime-mailbox-handler-registry.js"),
    "utf8",
  );
  const agentAdminProfileSource = await readFile(
    fileUrl("../lib/agent/agent-admin-profile.js"),
    "utf8",
  );

  const activeConsumers = [
    { label: "watchdog index", source: indexSource },
    { label: "api routes", source: apiRouteSource },
    { label: "runtime mailbox handler registry", source: handlerRegistrySource },
    { label: "agent admin profile", source: agentAdminProfileSource },
  ];

  for (const consumer of activeConsumers) {
    assert.doesNotMatch(
      consumer.source,
      /import\s*\{[\s\S]*\bruntimeAgentConfigs\b[\s\S]*\}\s*from "\.\.?(?:\/lib)?\/state\.js"/,
      `${consumer.label} should not import raw runtimeAgentConfigs from state.js`,
    );
    assert.match(
      consumer.source,
      /from "\.\.\/lib\/agent\/agent-identity\.js"|from "\.\/lib\/agent\/agent-identity\.js"|from "\.\.\/agent\/agent-identity\.js"|from "\.\/agent-identity\.js"/,
      `${consumer.label} should use agent-identity as the runtime agent config owner`,
    );
  }
});

test("SSE routes use transport/sse helpers instead of the raw sseClients set", async () => {
  const dashboardRouteSource = await readFile(
    fileUrl("../routes/dashboard.js"),
    "utf8",
  );
  const apiRouteSource = await readFile(
    fileUrl("../routes/api.js"),
    "utf8",
  );
  const sseTransportSource = await readFile(
    fileUrl("../lib/transport/sse.js"),
    "utf8",
  );

  for (const [label, source] of [
    ["dashboard routes", dashboardRouteSource],
    ["api routes", apiRouteSource],
  ]) {
    assert.doesNotMatch(
      source,
      /import\s*\{[\s\S]*\bsseClients\b[\s\S]*\}\s*from "\.\.\/lib\/state\.js"/,
      `${label} should not import raw sseClients from state.js`,
    );
    assert.match(
      source,
      /from "\.\.\/lib\/transport\/sse\.js"/,
      `${label} should use transport/sse helpers`,
    );
  }

  assert.match(
    sseTransportSource,
    /export function addSseClient|export function getSseClientCount|export function removeSseClient/,
    "transport/sse should own the sse client registry helpers",
  );
});

test("QQ typing interval consumers use channel-notify helpers instead of raw typing maps", async () => {
  const indexSource = await readFile(
    fileUrl("../index.js"),
    "utf8",
  );
  const runtimeAdminSource = await readFile(
    fileUrl("../lib/admin/runtime-admin.js"),
    "utf8",
  );
  const channelNotifySource = await readFile(
    fileUrl("../lib/channel-notify.js"),
    "utf8",
  );

  for (const [label, source] of [
    ["watchdog index", indexSource],
    ["runtime admin", runtimeAdminSource],
  ]) {
    assert.doesNotMatch(
      source,
      /\bqqTypingIntervals\b/,
      `${label} should not use raw QQ typing maps`,
    );
    assert.match(
      source,
      /from "\.\/lib\/channel-notify\.js"|from "\.\.\/channel-notify\.js"/,
      `${label} should use channel-notify typing helpers`,
    );
  }

  assert.match(
    channelNotifySource,
    /export function listQQTypingContracts|export function qqTypingStopAll/,
    "channel-notify should own helper APIs for typing interval inspection and reset",
  );
});

test("state persistence uses store owners instead of raw tracker and dispatchChain collections", async () => {
  const statePersistenceSource = await readFile(
    fileUrl("../lib/state-persistence.js"),
    "utf8",
  );

  assert.doesNotMatch(
    statePersistenceSource,
    /import\s*\{\s*tracker\s*,\s*dispatchChain\s*\}\s*from "\.\/state-collections\.js"/,
    "state-persistence should not import raw tracker/dispatchChain collections",
  );
  assert.match(
    statePersistenceSource,
    /from "\.\/store\/tracker-store\.js"/,
    "state-persistence should read resumable tracking snapshots through tracker-store",
  );
  assert.match(
    statePersistenceSource,
    /from "\.\/store\/contract-flow-store\.js"/,
    "state-persistence should read dispatch chain snapshots through contract-flow-store",
  );
});
