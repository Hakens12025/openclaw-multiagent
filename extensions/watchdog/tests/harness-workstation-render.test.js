/**
 * harness-workstation-render.test.js — 塑形套件「调试工作台」渲染单测
 *
 * live 数据当前无 module-bearing run（全 freeform/agent_end，moduleRuns 空），
 * 故用合成 HarnessRun（带 moduleRuns）验证 renderWorkstation 的流水线/明细/历史/空态渲染，
 * 不依赖 live 数据。mock dashboard-common(esc) + dashboard-i18n（浏览器全局，node 里需替身）。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";

mock.module("../dashboard-common.js", {
  namedExports: {
    esc: (s) => String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"),
    getToken: () => "t",
    showToast: () => {},
  },
});
mock.module("../dashboard-i18n.js", {
  namedExports: {
    getCurrentLang: () => "zh-CN",
    formatDateTime: (v) => String(v ?? ""),
  },
});

const { renderWorkstation, validateCompositionClient } = await import("../dashboard-harness-workstation.js");

function model() {
  return {
    placements: [
      { id: "auto-A", runtimeStatus: "failed", executionMode: "guarded", harnessProfileId: "coding.patch_and_test" },
      { id: "auto-B", runtimeStatus: "completed" },
    ],
    selectedAutomationId: "auto-A",
    selectedRun: {
      automationId: "auto-A", round: 2, status: "failed",
      moduleRuns: [
        { moduleId: "harness:gate.test", kind: "gate", status: "failed", summary: "test gate failed", reason: "test_gate_failed", evidence: { testSignal: "failed" } },
        { moduleId: "harness:guard.budget", kind: "guard", status: "passed", summary: "ok", evidence: {} },
      ],
      gateSummary: { verdict: "failed" }, score: 0.4,
    },
    runsForSelected: [
      { automationId: "auto-A", round: 2, status: "failed", gateSummary: { verdict: "failed" } },
      { automationId: "auto-A", round: 1, status: "completed", gateSummary: { verdict: "passed" } },
    ],
    selectedModuleId: "harness:gate.test",
  };
}

test("workstation：harness 列表渲染 + 选中高亮", () => {
  const html = renderWorkstation(model());
  assert.match(html, /data-automation-id="auto-A"/);
  assert.match(html, /auto-B/);
  assert.match(html, /is-selected/);
});

test("workstation：流水线按 kind 顺序(guard 先于 gate)+ 状态色类", () => {
  const html = renderWorkstation(model());
  assert.match(html, /data-module-id="harness:guard\.budget"/);
  assert.match(html, /data-module-id="harness:gate\.test"/);
  const idxGuard = html.indexOf('data-module-id="harness:guard.budget"');
  const idxGate = html.indexOf('data-module-id="harness:gate.test"');
  assert.ok(idxGuard !== -1 && idxGate !== -1 && idxGuard < idxGate, "guard 节点应排在 gate 之前");
  assert.match(html, /ws-node-failed/);
  assert.match(html, /ws-node-passed/);
});

test("workstation：选中模块明细渲染 reason + 证据字段", () => {
  const html = renderWorkstation(model());
  assert.match(html, /test_gate_failed/);
  assert.match(html, /testSignal/);
});

test("workstation：运行历史多轮渲染", () => {
  const html = renderWorkstation(model());
  assert.match(html, /data-run-round="2"/);
  assert.match(html, /data-run-round="1"/);
});

test("workstation：空 run → 流水线空态(不抛)", () => {
  const html = renderWorkstation({
    placements: [{ id: "x", runtimeStatus: "completed" }],
    selectedAutomationId: "x", selectedRun: null, runsForSelected: [], selectedModuleId: null,
  });
  assert.match(html, /ws-pipeline-empty/);
});

test("workstation：触发按钮带 automationId", () => {
  const html = renderWorkstation(model());
  assert.match(html, /data-ws-action="trigger"/);
  assert.match(html, /data-automation-id="auto-A"/);
});

// ── B-v2: 客户端组装校验 + 编辑模态 + 校验条 ──────────────────────────────────

const CATALOG = {
  modules: [
    { id: "harness:guard.budget", kind: "guard" },
    { id: "harness:guard.tool_access", kind: "guard" },
    { id: "harness:collector.artifact", kind: "collector" },
    { id: "harness:collector.trace", kind: "collector" },
    { id: "harness:gate.test", kind: "gate" },
    { id: "harness:gate.artifact", kind: "gate" },
    { id: "harness:normalizer.eval_input", kind: "normalizer" },
    { id: "harness:normalizer.failure", kind: "normalizer" },
  ],
};
const kindMap = Object.fromEntries(CATALOG.modules.map((m) => [m.id, m.kind]));

test("validateCompositionClient：与服务端规则一致(no_gate warn / 完整 ok / gate-no-collector info)", () => {
  assert.equal(validateCompositionClient([], kindMap).length, 0, "freeform 空 → 无");
  assert.equal(validateCompositionClient(["harness:guard.budget", "harness:gate.test", "harness:collector.artifact", "harness:normalizer.failure"], kindMap).length, 0, "完整 → 无");
  const noGate = validateCompositionClient(["harness:guard.budget", "harness:collector.artifact"], kindMap);
  assert.ok(noGate.some((p) => p.severity === "warn"), "无 gate → warn");
  const gateNoColl = validateCompositionClient(["harness:guard.budget", "harness:gate.test"], kindMap);
  assert.ok(gateNoColl.some((p) => p.severity === "info"), "gate 无 collector → info");
});

test("renderWorkstation：editing → 渲染编辑模态(模块 chip + 保存)", () => {
  const html = renderWorkstation({
    placements: [{ id: "auto-A", runtimeStatus: "completed", editable: true }],
    selectedAutomationId: "auto-A",
    catalog: CATALOG,
    editing: "auto-A",
    draftModuleRefs: ["harness:gate.test"],
  });
  assert.match(html, /ws-modal-backdrop/);
  assert.match(html, /data-ws-toggle-module="harness:gate\.test"/);
  assert.match(html, /ws-mod-chip is-on/, "已选模块应高亮");
  assert.match(html, /data-ws-action="save-edit"/);
  assert.match(html, /data-ws-action="cancel-edit"/);
});

test("renderWorkstation：showComposition → 校验条显示(无 gate 警告)", () => {
  const html = renderWorkstation({
    placements: [{ id: "auto-A", runtimeStatus: "completed", editable: true, moduleRefs: ["harness:guard.budget"] }],
    selectedAutomationId: "auto-A",
    catalog: CATALOG,
    showComposition: true,
  });
  assert.match(html, /ws-comp-strip/);
  assert.match(html, /ws-comp-warn/, "只有 guard 无 gate → warn");
});

test("renderWorkstation：editable 门控(可编辑→改可点;不可编辑→置灰)", () => {
  const editable = renderWorkstation({ placements: [{ id: "a", runtimeStatus: "completed", editable: true }], selectedAutomationId: "a", catalog: CATALOG });
  assert.match(editable, /data-ws-action="edit"/, "editable → 改 按钮可点");
  const notEditable = renderWorkstation({ placements: [{ id: "b", runtimeStatus: "completed", editable: false }], selectedAutomationId: "b", catalog: CATALOG });
  assert.doesNotMatch(notEditable, /data-ws-action="edit"/, "不可编辑 → 改 按钮置灰(无 action)");
});
