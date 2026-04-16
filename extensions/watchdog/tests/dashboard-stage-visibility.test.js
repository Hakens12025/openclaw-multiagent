import test from "node:test";
import assert from "node:assert/strict";

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

class MockClassList {
  constructor(element) {
    this.element = element;
    this.tokens = new Set();
  }

  add(...tokens) {
    tokens.forEach((token) => this.tokens.add(token));
    this.element.className = [...this.tokens].join(" ");
  }

  remove(...tokens) {
    tokens.forEach((token) => this.tokens.delete(token));
    this.element.className = [...this.tokens].join(" ");
  }

  toggle(token, force) {
    if (force === true) {
      this.tokens.add(token);
    } else if (force === false) {
      this.tokens.delete(token);
    } else if (this.tokens.has(token)) {
      this.tokens.delete(token);
    } else {
      this.tokens.add(token);
    }
    this.element.className = [...this.tokens].join(" ");
    return this.tokens.has(token);
  }
}

function selectorMatches(element, selector) {
  const normalized = String(selector || "").trim();
  if (!normalized) return false;
  if (normalized.startsWith("#")) {
    return element.id === normalized.slice(1);
  }
  if (normalized.startsWith(".")) {
    const classes = normalized.slice(1).split(".").filter(Boolean);
    return classes.every((token) => element.classList.tokens.has(token));
  }
  if (normalized.startsWith("[")) {
    const attr = normalized.slice(1, -1);
    if (!attr) return false;
    const [rawName, rawValue] = attr.split("=");
    const name = String(rawName || "").trim();
    if (!name) return false;
    const expectedValue = rawValue ? rawValue.replace(/^["']|["']$/g, "") : null;
    const actualValue = element.attributes[name];
    return expectedValue == null ? actualValue !== undefined : actualValue === expectedValue;
  }
  return element.tagName.toLowerCase() === normalized.toLowerCase();
}

function collectMatches(root, selector, results = []) {
  for (const child of root.children || []) {
    if (selectorMatches(child, selector)) {
      results.push(child);
    }
    collectMatches(child, selector, results);
  }
  return results;
}

class MockElement {
  constructor(tagName = "div", ownerDocument = null) {
    this.tagName = String(tagName || "div").toUpperCase();
    this.ownerDocument = ownerDocument;
    this.children = [];
    this.parentNode = null;
    this.style = {};
    this.dataset = {};
    this.attributes = {};
    this._className = "";
    this._svgClassName = {
      baseVal: "",
      toString() {
        return this.baseVal;
      },
    };
    this.classList = new MockClassList(this);
    this._innerHTML = "";
    this._textContent = "";
  }

  appendChild(child) {
    if (!child) return child;
    this.children.push(child);
    child.parentNode = this;
    return child;
  }

  removeChild(child) {
    this.children = this.children.filter((entry) => entry !== child);
    if (child) child.parentNode = null;
    return child;
  }

  remove() {
    if (this.parentNode) {
      this.parentNode.removeChild(this);
    }
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name === "id") {
      this.id = String(value);
      this.ownerDocument?.elements.set(this.id, this);
    }
  }

  getAttribute(name) {
    return this.attributes[name];
  }

  addEventListener() {}
  removeEventListener() {}
  closest() { return null; }

  get className() {
    return this._svgClassName;
  }

  set className(value) {
    this._className = String(value ?? "");
    this._svgClassName.baseVal = this._className;
  }

  get innerHTML() {
    return this._innerHTML;
  }

  set innerHTML(value) {
    this._innerHTML = String(value ?? "");
    this.children = [];
  }

  get textContent() {
    return this._textContent;
  }

  set textContent(value) {
    this._textContent = String(value ?? "");
    this._innerHTML = escapeHtml(this._textContent);
  }

  get childNodes() {
    return this.children;
  }

  get firstChild() {
    return this.children[0] || null;
  }

  querySelector(selector) {
    return collectMatches(this, selector, [])[0] || null;
  }

  querySelectorAll(selector) {
    return collectMatches(this, selector, []);
  }
}

class MockDocument {
  constructor() {
    this.elements = new Map();
    this.body = new MockElement("body", this);
  }

  createElement(tagName) {
    return new MockElement(tagName, this);
  }

  createElementNS(_ns, tagName) {
    return new MockElement(tagName, this);
  }

  getElementById(id) {
    if (!this.elements.has(id)) {
      const element = new MockElement("div", this);
      element.id = id;
      this.elements.set(id, element);
    }
    return this.elements.get(id);
  }

  querySelector() {
    return null;
  }

  querySelectorAll(selector) {
    return collectMatches(this.body, selector, []);
  }

  addEventListener() {}
  removeEventListener() {}
}

const originalGlobals = {
  document: globalThis.document,
  window: globalThis.window,
  localStorage: globalThis.localStorage,
  OC: globalThis.OC,
  fetch: globalThis.fetch,
  requestAnimationFrame: globalThis.requestAnimationFrame,
  setInterval: globalThis.setInterval,
  clearInterval: globalThis.clearInterval,
  setTimeout: globalThis.setTimeout,
  clearTimeout: globalThis.clearTimeout,
};

const document = new MockDocument();
for (const id of ["headerTime", "headerDate", "statUptime", "workItemList", "statWorkItems", "statCompleted", "statActive", "pipelineSvg"]) {
  document.getElementById(id);
}

globalThis.document = document;
globalThis.window = {
  _lastAgentData: [],
  _visiblePipelineAgentIds: [],
  location: { search: "" },
  innerWidth: 1440,
  innerHeight: 900,
};
globalThis.localStorage = {
  getItem() { return null; },
  setItem() {},
  removeItem() {},
};
globalThis.OC = {
  ux: { editMode: false },
  graph: {},
};
globalThis.fetch = async () => ({
  ok: false,
  async json() {
    return {};
  },
});
globalThis.requestAnimationFrame = (callback) => {
  if (typeof callback === "function") callback();
  return 1;
};
globalThis.setInterval = () => 1;
globalThis.clearInterval = () => {};
globalThis.setTimeout = () => 1;
globalThis.clearTimeout = () => {};

const dashboard = await import("../dashboard.js");
const dashboardSvg = await import("../dashboard-svg.js");

function resetDashboardState() {
  for (const key of Object.keys(dashboard.workItems)) delete dashboard.workItems[key];
  for (const key of Object.keys(dashboard.agentState)) delete dashboard.agentState[key];
  for (const key of Object.keys(dashboard.agentMeta)) delete dashboard.agentMeta[key];
  for (const key of Object.keys(dashboard.agentEvents)) delete dashboard.agentEvents[key];
  for (const key of Object.keys(dashboard.dispatchRuntimeState)) delete dashboard.dispatchRuntimeState[key];
  dashboard.dispatchQueueState.length = 0;
  dashboard.clearAllFlows();
  document.getElementById("workItemList").innerHTML = "";
  dashboard.renderWorkItems();
}

function findFlowGroup(flowId) {
  return document.getElementById("pipelineSvg").children
    .find((child) => child.attributes?.["data-flow"] === flowId) || null;
}

function getFlowPathClass(flow) {
  return String(flow?.querySelector("path")?.getAttribute("class") || "");
}

test("dashboard exports canonical dispatch runtime stores", () => {
  assert.equal("dispatchRuntimeState" in dashboard, true);
  assert.equal("dispatchQueueState" in dashboard, true);
  assert.equal("workerRuntimeState" in dashboard, false);
  assert.equal("workerQueueState" in dashboard, false);
  assert.equal("poolState" in dashboard, false);
  assert.equal("queueState" in dashboard, false);
});

test("dashboard folds non-controller gateway bridges into controller on main view", () => {
  resetDashboardState();

  dashboard.agentMeta.controller = { role: "bridge", gateway: true };
  dashboard.agentMeta["agent-for-kksl"] = { role: "bridge", gateway: true };

  assert.equal(dashboard.getPipelineAgentId("agent-for-kksl"), "controller");
  assert.deepEqual(
    dashboard.getPipelineAggregateAgentIds("controller").sort(),
    ["agent-for-kksl", "controller"],
  );
  assert.equal(dashboard.displayAgentRef("agent-for-kksl"), "controller");
});

test("buildPipelineSVG hides non-controller gateway bridge nodes on main dashboard", () => {
  dashboardSvg.buildPipelineSVG([
    { id: "controller", role: "bridge", gateway: true, model: "m1" },
    { id: "agent-for-kksl", role: "bridge", gateway: true, model: "m2" },
    { id: "planner", role: "planner", model: "m3" },
    { id: "plan2", role: "planner", model: "m4" },
    { id: "researcher", role: "researcher", model: "m5" },
    { id: "worker-a", role: "executor", model: "m6" },
    { id: "reviewer", role: "reviewer", model: "m7" },
  ]);

  assert.equal(window._visiblePipelineAgentIds.includes("controller"), true);
  assert.equal(window._visiblePipelineAgentIds.includes("agent-for-kksl"), false);
  assert.equal(window._visiblePipelineAgentIds.includes("planner"), true);
  assert.equal(window._visiblePipelineAgentIds.includes("plan2"), true);
  assert.equal(Boolean(dashboardSvg.nodePositions.controller), true);
  assert.equal(Boolean(dashboardSvg.nodePositions["agent-for-kksl"]), false);
  assert.equal(Boolean(dashboardSvg.nodePositions.planner), true);
  assert.equal(Boolean(dashboardSvg.nodePositions.plan2), true);
});

test("event stream folds non-controller gateway bridge events into controller block", () => {
  resetDashboardState();
  dashboard.agentMeta.controller = { role: "bridge", gateway: true };
  dashboard.agentMeta["agent-for-kksl"] = { role: "bridge", gateway: true };

  dashboard.addEvent("track_start", {
    agentId: "agent-for-kksl",
    task: "qq ingress relay",
    status: "running",
    ts: 1,
  });

  assert.equal(Array.isArray(dashboard.agentEvents.controller), true);
  assert.equal(dashboard.agentEvents.controller.length, 1);
  assert.equal("agent-for-kksl" in dashboard.agentEvents, false);
  assert.match(document.getElementById("eventStream").innerHTML, /CONTROLLER/);
  assert.doesNotMatch(document.getElementById("eventStream").innerHTML, /AGENT-FOR-KKSL/);
});

test("processEvent renders execution-contract inbox dispatch as graph route flow", () => {
  resetDashboardState();
  dashboardSvg.buildPipelineSVG([
    { id: "controller", role: "bridge", gateway: true, model: "m1" },
    { id: "planner", role: "planner", model: "m2" },
  ]);

  dashboard.processEvent("alert", {
    type: "inbox_dispatch",
    from: "controller",
    assignee: "planner",
    contractId: "TC-ROUTE-1",
    task: "route this contract",
    protocolEnvelope: "execution_contract",
    ts: 1,
  });

  const flow = findFlowGroup("controller→planner");
  assert.ok(flow, "expected route flow group");
  assert.match(getFlowPathClass(flow), /flow-graph-route/);
  assert.doesNotMatch(getFlowPathClass(flow), /flow-direct-dispatch/);
});

test("processEvent renders pipeline progression as graph route flow", () => {
  resetDashboardState();
  dashboardSvg.buildPipelineSVG([
    { id: "planner", role: "planner", model: "m1" },
    { id: "worker-a", role: "executor", model: "m2" },
  ]);

  dashboard.processEvent("alert", {
    type: "loop_started",
    from: "planner",
    to: "worker-a",
    targetAgent: "worker-a",
    contractId: "TC-ROUTE-2",
    round: 1,
    ts: 2,
  });

  const flow = findFlowGroup("planner→worker-a");
  assert.ok(flow, "expected pipeline route flow group");
  assert.match(getFlowPathClass(flow), /flow-pipeline-progress/);
  assert.doesNotMatch(getFlowPathClass(flow), /flow-graph-route/);
});

test("processEvent renders graph_dispatch as graph route flow", () => {
  resetDashboardState();
  dashboardSvg.buildPipelineSVG([
    { id: "controller", role: "bridge", gateway: true, model: "m1" },
    { id: "planner", role: "planner", model: "m2" },
  ]);

  dashboard.processEvent("graph_dispatch", {
    from: "controller",
    to: "planner",
    contractId: "TC-ROUTE-3",
    ts: 3,
  });

  const flow = findFlowGroup("controller→planner");
  assert.ok(flow, "expected graph_dispatch route flow group");
  assert.match(getFlowPathClass(flow), /flow-graph-route/);
});

test("processEvent keeps delivery return flow on reply lane", () => {
  resetDashboardState();
  dashboardSvg.buildPipelineSVG([
    { id: "controller", role: "bridge", gateway: true, model: "m1" },
    { id: "worker-a", role: "executor", model: "m2" },
  ]);
  window.__graphEdges = [];

  dashboard.processEvent("track_end", {
    agentId: "worker-a",
    status: "completed",
    replyTo: { agentId: "controller" },
    runtimeDiagnostics: {
      completionEgress: {
        ok: true,
        channel: "qq",
        workflow: "delivery:terminal",
      },
    },
    ts: 4,
  });

  const flow = findFlowGroup("worker-a→controller");
  assert.ok(flow, "expected reply flow group");
  assert.match(getFlowPathClass(flow), /flow-terminal-delivery/);
});

test("processEvent does not render terminal reply lane for system_action return-only completion", () => {
  resetDashboardState();
  dashboardSvg.buildPipelineSVG([
    { id: "planner", role: "planner", model: "m1" },
    { id: "worker-a", role: "executor", model: "m2" },
  ]);
  window.__graphEdges = [];

  dashboard.processEvent("track_end", {
    agentId: "worker-a",
    status: "completed",
    replyTo: { agentId: "planner" },
    runtimeDiagnostics: {
      systemActionDelivery: {
        system_action_contract_result: {
          handled: true,
          workflow: "delivery:system_action_contract_result",
          targetAgent: "planner",
          suppressCompletionEgress: true,
        },
      },
    },
    ts: 5,
  });

  const flow = findFlowGroup("worker-a→planner");
  assert.equal(flow, null, "system_action return should not reuse terminal delivery lane");
});

test("processEvent renders system_action delivery alerts on dedicated return lane", () => {
  resetDashboardState();
  dashboardSvg.buildPipelineSVG([
    { id: "planner", role: "planner", model: "m1" },
    { id: "worker-a", role: "executor", model: "m2" },
  ]);

  dashboard.processEvent("alert", {
    type: "system_action_contract_result_delivered",
    source: "worker-a",
    targetAgent: "planner",
    contractId: "TC-SYSTEM-RETURN-1",
    ts: 6,
  });

  const flow = findFlowGroup("worker-a→planner");
  assert.ok(flow, "expected system_action return flow group");
  assert.match(getFlowPathClass(flow), /flow-system-action-delivery/);
  assert.doesNotMatch(getFlowPathClass(flow), /flow-terminal-delivery/);
});

test.after(() => {
  globalThis.document = originalGlobals.document;
  globalThis.window = originalGlobals.window;
  globalThis.localStorage = originalGlobals.localStorage;
  globalThis.OC = originalGlobals.OC;
  globalThis.fetch = originalGlobals.fetch;
  globalThis.requestAnimationFrame = originalGlobals.requestAnimationFrame;
  globalThis.setInterval = originalGlobals.setInterval;
  globalThis.clearInterval = originalGlobals.clearInterval;
  globalThis.setTimeout = originalGlobals.setTimeout;
  globalThis.clearTimeout = originalGlobals.clearTimeout;
});

test("renderWorkItems shows canonical phases even when runtime projection is ui_activity_placeholder", () => {
  resetDashboardState();

  dashboard.mergeWorkItemState("C-1", {
    task: "帮我研究优化一下希尔排序的优缺点",
    assignee: "researcher",
    status: "pending",
    createdAt: 1,
    updatedAt: 1,
    phases: ["明确希尔排序的评价维度与优化目标", "分析希尔排序的优缺点与可优化点", "形成希尔排序的优化建议"],
    total: 3,
    stagePlan: {
      contractId: "C-1",
      stages: [
        { id: "stage-1", label: "明确希尔排序的评价维度与优化目标", semanticLabel: "明确希尔排序的评价维度与优化目标", status: "active" },
        { id: "stage-2", label: "分析希尔排序的优缺点与可优化点", semanticLabel: "分析希尔排序的优缺点与可优化点", status: "pending" },
        { id: "stage-3", label: "形成希尔排序的优化建议", semanticLabel: "形成希尔排序的优化建议", status: "pending" },
      ],
      revisionPolicy: { maxRevisions: 2, maxStageDelta: 1 },
    },
    stageRuntime: {
      version: 1,
      currentStageId: "stage-1",
      completedStageIds: [],
      revisionCount: 0,
      lastRevisionReason: null,
    },
    stageProjection: { source: "ui_activity_placeholder", stagePlan: [], total: 0 },
  });

  dashboard.renderWorkItems();

  assert.match(document.getElementById("workItemList").innerHTML, /明确希尔排序的评价维度与优化目标/);
});

test("renderWorkItems re-renders when canonical phases change without lifecycle hash fields changing", () => {
  resetDashboardState();

  dashboard.mergeWorkItemState("C-2", {
    task: "研究排序算法",
    assignee: "researcher",
    status: "running",
    createdAt: 2,
    updatedAt: 2,
    pct: 34,
    toolCallCount: 1,
    phases: ["收集证据"],
    stageProjection: { source: "task_stage_truth" },
  });

  dashboard.renderWorkItems();
  assert.match(document.getElementById("workItemList").innerHTML, /收集证据/);

  dashboard.mergeWorkItemState("C-2", {
    phases: ["收集证据", "形成结论"],
  });

  dashboard.renderWorkItems();

  assert.match(document.getElementById("workItemList").innerHTML, /形成结论/);
});

test("buildLifecyclePatchFromAlert carries canonical stage truth for dispatch alerts", () => {
  resetDashboardState();

  const stagePlan = {
    contractId: "C-3",
    stages: [
      { id: "stage-1", label: "收集证据", semanticLabel: "收集证据", status: "active" },
      { id: "stage-2", label: "形成结论", semanticLabel: "形成结论", status: "pending" },
    ],
    revisionPolicy: { maxRevisions: 2, maxStageDelta: 1 },
  };
  const stageRuntime = {
    version: 1,
    currentStageId: "stage-1",
    completedStageIds: [],
    revisionCount: 0,
    lastRevisionReason: null,
  };

  const patch = dashboard.buildLifecyclePatchFromAlert({
    type: "inbox_dispatch",
    contractId: "C-3",
    task: "研究任务",
    assignee: "researcher",
    phases: ["收集证据", "形成结论"],
    total: 2,
    stagePlan,
    stageRuntime,
    ts: 3,
  });

  assert.deepEqual(patch.stagePlan, stagePlan);
  assert.deepEqual(patch.stageRuntime, stageRuntime);
  assert.deepEqual(patch.phases, ["收集证据", "形成结论"]);
  assert.equal(patch.total, 2);
});

test("processEvent preserves stageRuntime from progress payloads", () => {
  resetDashboardState();

  const stagePlan = {
    contractId: "C-4",
    stages: [
      { id: "stage-1", label: "收集证据", semanticLabel: "收集证据", status: "completed" },
      { id: "stage-2", label: "形成结论", semanticLabel: "形成结论", status: "active" },
    ],
    revisionPolicy: { maxRevisions: 2, maxStageDelta: 1 },
  };
  const stageRuntime = {
    version: 2,
    currentStageId: "stage-2",
    completedStageIds: ["stage-1"],
    revisionCount: 0,
    lastRevisionReason: null,
  };

  dashboard.processEvent("track_progress", {
    agentId: "researcher",
    hasContract: true,
    contractId: "C-4",
    task: "研究任务",
    status: "running",
    assignee: "researcher",
    stagePlan,
    stageRuntime,
    stageProjection: {
      source: "task_stage_truth",
      confidence: "planner",
      stagePlan: ["收集证据", "形成结论"],
      completedStages: ["收集证据"],
      currentStage: "stage-2",
      currentStageLabel: "形成结论",
      cursor: "1/2",
      pct: 50,
      total: 2,
    },
    phases: ["收集证据", "形成结论"],
    total: 2,
    ts: 4,
  });

  assert.deepEqual(dashboard.workItems["C-4"]?.stageRuntime, stageRuntime);
});

test("processEvent prefers structured tool timeline summaries for track_progress events", () => {
  resetDashboardState();

  const recentToolEvents = [
    {
      index: 4,
      tool: "exec",
      kind: "exec",
      label: "执行: npm test",
      summary: "执行完成 (420ms): npm test -- --runInBand",
      status: "ok",
      durationMs: 420,
      runId: "run-dashboard-tool-stream",
      toolCallId: "call-dashboard-tool-stream",
      ts: 41,
    },
  ];

  dashboard.processEvent("track_progress", {
    agentId: "researcher",
    sessionKey: "agent:researcher:tool-stream",
    hasContract: true,
    contractId: "C-TOOL-1",
    task: "研究任务",
    status: "running",
    assignee: "researcher",
    toolCallCount: 4,
    lastLabel: "执行: npm test",
    recentToolEvents,
    ts: 42,
  });

  assert.match(dashboard.agentEvents.researcher?.[0]?.body || "", /执行完成 \(420ms\): npm test -- --runInBand/);
  assert.deepEqual(dashboard.workItems["C-TOOL-1"]?.recentToolEvents, recentToolEvents);
});

test("processEvent renders artifact-backed reviewer work items from progress payloads", () => {
  resetDashboardState();

  dashboard.processEvent("track_start", {
    agentId: "reviewer",
    sessionKey: "agent:reviewer:main",
    workItemId: "artifact:code_review:agent:reviewer:main",
    workItemKind: "artifact_backed",
    hasContract: false,
    task: "代码审查: 请审查当前实现并给出 verdict",
    status: "running",
    assignee: "reviewer",
    taskType: "request_review",
    protocolEnvelope: "code_review",
    stageProjection: {
      source: "artifact_context",
      confidence: "protocol",
      stagePlan: ["代码审查"],
      completedStages: [],
      currentStage: "code_review",
      currentStageLabel: "代码审查",
      cursor: "0/1",
      pct: 0,
      total: 1,
    },
    phases: ["代码审查"],
    total: 1,
    ts: 5,
  });

  assert.equal(dashboard.workItems["artifact:code_review:agent:reviewer:main"]?.taskType, "request_review");
  assert.match(document.getElementById("workItemList").innerHTML, /代码审查/);
});

test("processEvent updates artifact-backed work items from alert payloads using workItemId", () => {
  resetDashboardState();

  dashboard.processEvent("alert", {
    type: "inbox_dispatch",
    workItemId: "artifact:code_review:agent:reviewer:alert",
    workItemKind: "artifact_backed",
    hasContract: false,
    from: "planner",
    task: "代码审查: 检查当前改动是否满足规范",
    assignee: "reviewer",
    taskType: "request_review",
    protocolEnvelope: "code_review",
    stagePlan: {
      stages: [
        { id: "code_review", label: "代码审查", semanticLabel: "代码审查" },
      ],
    },
    stageRuntime: {
      version: 1,
      currentStageId: "code_review",
      completedStageIds: [],
      revisionCount: 0,
      lastRevisionReason: null,
    },
    phases: ["代码审查"],
    total: 1,
    ts: 6,
  });

  assert.equal(
    dashboard.workItems["artifact:code_review:agent:reviewer:alert"]?.taskType,
    "request_review",
  );
  assert.deepEqual(
    dashboard.workItems["artifact:code_review:agent:reviewer:alert"]?.stageRuntime,
    {
      version: 1,
      currentStageId: "code_review",
      completedStageIds: [],
      revisionCount: 0,
      lastRevisionReason: null,
    },
  );
});

test("processEvent does not create work item cards for session-only track_end events", () => {
  resetDashboardState();

  dashboard.processEvent("track_end", {
    agentId: "controller",
    sessionKey: "agent:controller:main",
    status: "completed",
    hasContract: false,
    workItemKind: null,
    ts: 7,
    elapsedMs: 1500,
  });

  assert.equal("agent:controller:main" in dashboard.workItems, false);
  assert.doesNotMatch(document.getElementById("workItemList").innerHTML, /agent:controller:main/);
});
