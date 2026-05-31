import test from "node:test";
import assert from "node:assert/strict";

import { renderWorkItemsPage } from "../dashboard-work-items.js";
import { setLang } from "../dashboard-i18n.js";

function buildHost() {
  return {
    summary: { innerHTML: "" },
    toolbar: { innerHTML: "" },
    list: { innerHTML: "" },
    detail: { innerHTML: "" },
  };
}

test("renderWorkItemsPage shows filtered rows and selected detail", () => {
  const items = [
    { id: "TC-2", task: "写评估摘要", assignee: "planner", status: "completed", updatedAt: 20 },
    { id: "TC-1", task: "补 runtime truth", assignee: "worker", status: "failed", updatedAt: 10 },
  ];
  const host = buildHost();

  const result = renderWorkItemsPage({
    items,
    filters: { status: "failed", assignee: "all", query: "" },
    selectedId: "TC-1",
    host,
  });

  assert.equal(result.selectedId, "TC-1");
  assert.match(host.summary.innerHTML, /总数/);
  assert.match(host.list.innerHTML, /TC-1/);
  assert.doesNotMatch(host.list.innerHTML, /TC-2/);
  assert.match(host.detail.innerHTML, /补 runtime truth/);
});

test("renderWorkItemsPage resets selection to newest visible item after filters change", () => {
  const items = [
    { id: "TC-3", task: "排查阻塞", assignee: "worker", status: "running", updatedAt: 30 },
    { id: "TC-2", task: "写评估摘要", assignee: "planner", status: "completed", updatedAt: 20 },
    { id: "TC-1", task: "补 runtime truth", assignee: "worker", status: "failed", updatedAt: 10 },
  ];
  const host = buildHost();

  const result = renderWorkItemsPage({
    items,
    filters: { status: "completed", assignee: "all", query: "" },
    selectedId: "TC-3",
    host,
  });

  assert.equal(result.selectedId, "TC-2");
  assert.match(host.list.innerHTML, /TC-2/);
  assert.doesNotMatch(host.list.innerHTML, /TC-3/);
  assert.match(host.detail.innerHTML, /写评估摘要/);
});

test("renderWorkItemsPage follows i18n labels instead of hardcoded chinese text", () => {
  setLang("en-US");
  const host = buildHost();

  const result = renderWorkItemsPage({
    items: [
      { id: "TC-1", task: "Review graph router", assignee: "worker", status: "failed", updatedAt: 10 },
    ],
    filters: { status: "all", assignee: "all", query: "" },
    selectedId: null,
    host,
  });

  assert.equal(result.selectedId, "TC-1");
  assert.match(host.summary.innerHTML, /TOTAL/);
  assert.match(host.toolbar.innerHTML, /SEARCH/);
  assert.match(host.detail.innerHTML, /FAILED/);

  setLang("zh-CN");
});

test("renderWorkItemsPage renders grouped operator coordination and terminal details", () => {
  setLang("en-US");
  const host = buildHost();

  renderWorkItemsPage({
    items: [
      {
        id: "TC-9",
        task: "排查 loop 回路",
        assignee: "worker-3",
        status: "failed",
        updatedAt: 20,
        requestedSource: "runtime.loop.start",
        operatorContext: {
          originSurfaceId: "runtime.loop.start",
          originExecutionId: "EX-123",
        },
        coordination: {
          owner: { agentId: "worker-3" },
          return: {
            mode: "none",
            sourceAgentId: "planner",
          },
        },
        terminalOutcome: {
          status: "failed",
          source: "runtime_recovery",
          reason: "gateway_restart",
          retryable: false,
          testsPassed: false,
          ts: 20,
        },
      },
    ],
    filters: { status: "all", assignee: "all", query: "" },
    selectedId: "TC-9",
    host,
  });

  assert.match(host.detail.innerHTML, /Operator Context/);
  assert.match(host.detail.innerHTML, /runtime\.loop\.start/);
  assert.match(host.detail.innerHTML, /Coordination/);
  assert.match(host.detail.innerHTML, /worker-3/);
  assert.match(host.detail.innerHTML, /Terminal Outcome/);
  assert.match(host.detail.innerHTML, /gateway_restart/);

  setLang("zh-CN");
});

test("renderWorkItemsPage keeps terminal reasons artifact-oriented for user display", () => {
  setLang("en-US");
  const host = buildHost();

  renderWorkItemsPage({
    items: [
      {
        id: "TC-12",
        task: "Runtime metadata boundary",
        assignee: "worker",
        status: "failed",
        updatedAt: 30,
        terminalOutcome: {
          status: "failed",
          source: "completion_criteria",
          reason: "missing required artifact evidence",
        },
      },
    ],
    filters: { status: "all", assignee: "all", query: "" },
    selectedId: "TC-12",
    host,
  });

  assert.match(host.detail.innerHTML, /missing required artifact evidence/);
  assert.doesNotMatch(host.detail.innerHTML, /completion proof/i);

  setLang("zh-CN");
});

test("renderWorkItemsPage prefers runtime stage projection over legacy pipeline stage", () => {
  setLang("en-US");
  const host = buildHost();

  renderWorkItemsPage({
    items: [
      {
        id: "TC-10",
        task: "Route through graph",
        assignee: "worker",
        status: "running",
        updatedAt: 30,
        activityProgress: {
          currentStage: "worker-runtime",
          round: 3,
        },
        stageProjection: {
          stage: "projected-worker",
          round: 2,
        },
        pipelineStage: {
          stage: "legacy-pipeline",
          round: 1,
        },
      },
    ],
    filters: { status: "all", assignee: "all", query: "" },
    selectedId: "TC-10",
    host,
  });

  assert.match(host.list.innerHTML, /worker-runtime/);
  assert.doesNotMatch(host.list.innerHTML, /legacy-pipeline/);
  assert.match(host.detail.innerHTML, /worker-runtime/);
  assert.match(host.detail.innerHTML, />3</);
  assert.doesNotMatch(host.detail.innerHTML, /legacy-pipeline/);

  setLang("zh-CN");
});

test("renderWorkItemsPage ignores legacy pipeline stage when runtime stage truth is absent", () => {
  setLang("en-US");
  const host = buildHost();

  renderWorkItemsPage({
    items: [
      {
        id: "TC-11",
        task: "Legacy pipeline residue",
        assignee: "worker",
        status: "running",
        updatedAt: 31,
        pipelineStage: {
          stage: "legacy-pipeline",
          round: 7,
        },
      },
    ],
    filters: { status: "all", assignee: "all", query: "" },
    selectedId: "TC-11",
    host,
  });

  assert.doesNotMatch(host.list.innerHTML, /legacy-pipeline/);
  assert.doesNotMatch(host.detail.innerHTML, /legacy-pipeline/);
  assert.match(host.list.innerHTML, /--/);

  setLang("zh-CN");
});
