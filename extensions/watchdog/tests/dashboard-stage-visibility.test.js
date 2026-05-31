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

  contains(token) {
    return this.tokens.has(token);
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
    this._id = "";
    this._svgClassName = {
      baseVal: "",
      toString() {
        return this.baseVal;
      },
    };
    this.classList = new MockClassList(this);
    this._innerHTML = "";
    this._textContent = "";
    this._listeners = new Map();
  }

  appendChild(child) {
    if (!child) return child;
    if (child.parentNode) {
      child.parentNode.children = child.parentNode.children.filter((entry) => entry !== child);
    }
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
    if (this.id && this.ownerDocument?.elements.get(this.id) === this) {
      this.ownerDocument.elements.delete(this.id);
    }
  }

  get id() {
    return this._id;
  }

  set id(value) {
    this._id = String(value ?? "");
    if (this._id) {
      this.attributes.id = this._id;
      this.ownerDocument?.elements.set(this._id, this);
    }
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name === "id") {
      this.id = String(value);
      this.ownerDocument?.elements.set(this.id, this);
    }
    if (name === "class") {
      this.className = String(value ?? "");
      this.classList.tokens = new Set(this._className.split(/\s+/u).filter(Boolean));
    }
  }

  getAttribute(name) {
    return this.attributes[name];
  }

  addEventListener(type, listener) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(listener);
  }

  removeEventListener(type, listener) {
    if (!this._listeners.has(type)) return;
    this._listeners.set(type, this._listeners.get(type).filter((entry) => entry !== listener));
  }

  dispatchEvent(event) {
    for (const listener of this._listeners.get(event?.type) || []) listener.call(this, event);
    return true;
  }
  closest() { return null; }
  focus() {}

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
    const workItemMatches = [...this._innerHTML.matchAll(/<div class="([^"]*\bwork-item-card\b[^"]*)"[^>]*data-work-item-id="([^"]+)"/g)];
    for (const match of workItemMatches) {
      const child = new MockElement("div", this.ownerDocument);
      child.setAttribute("class", match[1]);
      child.setAttribute("data-work-item-id", match[2]);
      this.appendChild(child);
    }
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
    this.missingElementIds = new Set();
    this.body = new MockElement("body", this);
  }

  createElement(tagName) {
    return new MockElement(tagName, this);
  }

  createElementNS(_ns, tagName) {
    return new MockElement(tagName, this);
  }

  getElementById(id) {
    if (this.missingElementIds.has(id)) return null;
    return this.elements.get(id);
  }

  ensureElement(id, tagName = "div") {
    if (!this.elements.has(id)) {
      const element = new MockElement(tagName, this);
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
for (const id of ["headerTime", "headerDate", "statUptime", "workItemList", "eventStream", "statWorkItems", "statCompleted", "statActive", "statQueue", "runtimeGraphSvg"]) {
  document.ensureElement(id, id === "runtimeGraphSvg" ? "svg" : "div");
}

globalThis.document = document;
globalThis.window = {
  _lastAgentData: [],
  _visibleRuntimeGraphAgentIds: [],
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
const dashboardGraph = await import("../dashboard-graph.js");
const dashboardUx = await import("../dashboard-ux.js");
const { ContractCardView } = await import("../dashboard-contract-card.js");
const { ContractFlowAnimator } = await import("../dashboard-contract-flow-animator.js");

function resetDashboardState() {
  for (const key of Object.keys(dashboard.workItems)) delete dashboard.workItems[key];
  for (const key of Object.keys(dashboard.agentState)) delete dashboard.agentState[key];
  for (const key of Object.keys(dashboard.agentMeta)) delete dashboard.agentMeta[key];
  for (const key of Object.keys(dashboard.agentEvents)) delete dashboard.agentEvents[key];
  for (const key of Object.keys(dashboard.dispatchRuntimeState)) delete dashboard.dispatchRuntimeState[key];
  dashboard.clearAllFlows();
  document.getElementById("workItemList").innerHTML = "";
  document.getElementById("statQueue").textContent = "";
  dashboard.renderWorkItems();
}

function findFlowGroup(flowId) {
  return document.getElementById("runtimeGraphSvg").children
    .find((child) => child.attributes?.["data-flow"] === flowId) || null;
}

function getFlowPathClass(flow) {
  return String(flow?.querySelector("path")?.getAttribute("class") || "");
}

test("dashboard exports canonical dispatch runtime stores", () => {
  assert.equal("dispatchRuntimeState" in dashboard, true);
  assert.equal("dispatchQueueState" in dashboard, false);
  assert.equal("workerRuntimeState" in dashboard, false);
  assert.equal("workerQueueState" in dashboard, false);
  assert.equal("poolState" in dashboard, false);
  assert.equal("queueState" in dashboard, false);
});

test("dashboard folds non-controller gateway bridges into controller on main view", () => {
  resetDashboardState();

  dashboard.agentMeta.controller = { role: "bridge", gateway: true };
  dashboard.agentMeta["agent-for-kksl"] = { role: "bridge", gateway: true };

  assert.equal(dashboard.getRuntimeGraphAgentId("agent-for-kksl"), "controller");
  assert.deepEqual(
    dashboard.getRuntimeGraphAggregateAgentIds("controller").sort(),
    ["agent-for-kksl", "controller"],
  );
  assert.equal(dashboard.displayAgentRef("agent-for-kksl"), "controller");
});

test("buildRuntimeGraphSVG hides non-controller gateway bridge nodes on main dashboard", () => {
  dashboardSvg.buildRuntimeGraphSVG([
    { id: "controller", role: "bridge", gateway: true, model: "m1" },
    { id: "agent-for-kksl", role: "bridge", gateway: true, model: "m2" },
    { id: "planner", role: "planner", model: "m3" },
    { id: "plan2", role: "planner", model: "m4" },
    { id: "researcher", role: "researcher", model: "m5" },
    { id: "worker-a", role: "executor", model: "m6" },
    { id: "reviewer", role: "reviewer", model: "m7" },
  ]);

  assert.equal(window._visibleRuntimeGraphAgentIds.includes("controller"), true);
  assert.equal(window._visibleRuntimeGraphAgentIds.includes("agent-for-kksl"), false);
  assert.equal(window._visibleRuntimeGraphAgentIds.includes("planner"), true);
  assert.equal(window._visibleRuntimeGraphAgentIds.includes("plan2"), true);
  assert.equal(Boolean(dashboardSvg.nodePositions.controller), true);
  assert.equal(Boolean(dashboardSvg.nodePositions["agent-for-kksl"]), false);
  assert.equal(Boolean(dashboardSvg.nodePositions.planner), true);
  assert.equal(Boolean(dashboardSvg.nodePositions.plan2), true);
});

test("buildRuntimeGraphSVG hides runtime operator from the main agent graph", () => {
  dashboardSvg.buildRuntimeGraphSVG([
    { id: "controller", role: "bridge", gateway: true, model: "m1" },
    { id: "operator", role: "agent", systemControl: true, model: "m2" },
    { id: "planner", role: "planner", model: "m3" },
  ]);

  const svg = document.getElementById("runtimeGraphSvg");
  assert.equal(window._visibleRuntimeGraphAgentIds.includes("operator"), false);
  assert.equal(Boolean(dashboardSvg.nodePositions.operator), false);
  assert.equal(svg.querySelector('[data-agent="operator"]'), null);
  assert.equal(window._visibleRuntimeGraphAgentIds.includes("controller"), true);
  assert.equal(window._visibleRuntimeGraphAgentIds.includes("planner"), true);
});

test("buildRuntimeGraphSVG hides system-control surfaces from the main agent graph", () => {
  dashboardSvg.buildRuntimeGraphSVG([
    { id: "controller", role: "bridge", gateway: true, model: "m1" },
    { id: "harness", role: "harness", model: "m2" },
    { id: "cli-system", role: "cli-system", model: "m3" },
    { id: "automation", role: "automation", model: "m4" },
    { id: "planner", role: "planner", model: "m5" },
  ]);

  const svg = document.getElementById("runtimeGraphSvg");
  assert.equal(window._visibleRuntimeGraphAgentIds.includes("harness"), false);
  assert.equal(window._visibleRuntimeGraphAgentIds.includes("cli-system"), false);
  assert.equal(window._visibleRuntimeGraphAgentIds.includes("automation"), false);
  assert.equal(svg.querySelector('[data-agent="harness"]'), null);
  assert.equal(svg.querySelector('[data-agent="cli-system"]'), null);
  assert.equal(svg.querySelector('[data-agent="automation"]'), null);
  assert.equal(window._visibleRuntimeGraphAgentIds.includes("controller"), true);
  assert.equal(window._visibleRuntimeGraphAgentIds.includes("planner"), true);
});

test("event stream folds system-control surface events into the system block", () => {
  resetDashboardState();

  dashboard.addEvent("track_progress", {
    agentId: "Harness",
    toolCallCount: 1,
    lastLabel: "collect evidence",
  });
  dashboard.addEvent("track_progress", {
    agentId: "cli-system",
    toolCallCount: 2,
    lastLabel: "run surface",
  });
  dashboard.addEvent("track_progress", {
    agentId: "automation",
    toolCallCount: 3,
    lastLabel: "schedule due",
  });

  const eventStream = document.getElementById("eventStream");
  assert.match(eventStream.innerHTML, /SYSTEM/);
  assert.doesNotMatch(eventStream.innerHTML, /HARNESS/);
  assert.doesNotMatch(eventStream.innerHTML, /CLI-SYSTEM/);
  assert.doesNotMatch(eventStream.innerHTML, /AUTOMATION/);
  assert.equal((eventStream.innerHTML.match(/system-event-block/g) || []).length, 1);
});

test("buildRuntimeGraphSVG respects mainViewVisible false for control-plane agents", () => {
  dashboardSvg.buildRuntimeGraphSVG([
    { id: "controller", role: "bridge", gateway: true, model: "m1" },
    { id: "control-helper", role: "agent", mainViewVisible: false, model: "m2" },
    { id: "planner", role: "planner", model: "m3" },
  ]);

  const svg = document.getElementById("runtimeGraphSvg");
  assert.equal(window._visibleRuntimeGraphAgentIds.includes("control-helper"), false);
  assert.equal(Boolean(dashboardSvg.nodePositions["control-helper"]), false);
  assert.equal(svg.querySelector('[data-agent="control-helper"]'), null);
  assert.equal(window._visibleRuntimeGraphAgentIds.includes("controller"), true);
  assert.equal(window._visibleRuntimeGraphAgentIds.includes("planner"), true);
});

test("loadAgentMeta keeps the current graph when agents endpoint returns an empty list", async () => {
  resetDashboardState();
  dashboard.agentMeta.controller = { id: "controller", role: "bridge", gateway: true, model: "m1" };
  dashboard.agentState.controller = { status: "idle" };
  dashboardSvg.buildRuntimeGraphSVG([
    { id: "controller", role: "bridge", gateway: true, model: "m1" },
    { id: "planner", role: "planner", model: "m2" },
  ]);

  globalThis.fetch = async (url) => {
    if (String(url).startsWith("/watchdog/agents")) {
      return {
        ok: true,
        async json() {
          return [];
        },
      };
    }
    return {
      ok: true,
      async json() {
        return [];
      },
    };
  };

  await dashboard.loadAgentMeta();

  assert.equal("controller" in dashboard.agentMeta, true);
  assert.equal("controller" in dashboard.agentState, true);
  assert.deepEqual(window._visibleRuntimeGraphAgentIds, ["controller", "planner"]);
  assert.equal(Boolean(dashboardSvg.nodePositions.controller), true);
});

test("buildRuntimeGraphSVG renders only real agent nodes and no synthetic result node", () => {
  resetDashboardState();

  dashboardSvg.buildRuntimeGraphSVG([
    { id: "controller", role: "bridge", gateway: true, model: "m1" },
    { id: "planner", role: "planner", model: "m2" },
    { id: "worker-a", role: "executor", model: "m3" },
  ]);

  const svg = document.getElementById("runtimeGraphSvg");
  assert.equal(Boolean(dashboardSvg.nodePositions._result), false);
  assert.equal(svg.querySelector('[data-agent="_result"]'), null);
  assert.equal(svg.querySelector(".result-node"), null);
  assert.deepEqual(window._visibleRuntimeGraphAgentIds, ["controller", "planner", "worker-a"]);
});

test("buildRuntimeGraphSVG preserves active flow DOM across graph rebuilds", () => {
  resetDashboardState();

  const agents = [
    { id: "controller", role: "bridge", gateway: true, model: "m1" },
    { id: "planner", role: "planner", model: "m2" },
  ];
  dashboardSvg.buildRuntimeGraphSVG(agents);
  dashboard.addActiveFlow("controller", "planner", "ROUTE", { type: "graph-route" });
  assert.ok(findFlowGroup("controller→planner"), "expected initial flow group");

  dashboardSvg.buildRuntimeGraphSVG(agents);

  assert.ok(findFlowGroup("controller→planner"), "expected flow group after SVG rebuild");
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
  dashboardSvg.buildRuntimeGraphSVG([
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

test("processEvent renders loop progression as loop route flow", () => {
  resetDashboardState();
  dashboardSvg.buildRuntimeGraphSVG([
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
  assert.ok(flow, "expected loop route flow group");
  assert.match(getFlowPathClass(flow), /flow-loop-progress/);
  assert.doesNotMatch(getFlowPathClass(flow), /flow-graph-route/);
});

test("describeGraphRouteProgression uses loop route terminology in visible titles", () => {
  const advanced = dashboard.describeGraphRouteProgression({
    attempted: true,
    action: "advanced",
    from: "planner",
    to: "worker-a",
    round: 2,
  });
  const concluded = dashboard.describeGraphRouteProgression({
    attempted: true,
    action: "concluded",
    round: 3,
  });

  assert.equal(advanced?.title, "Runtime advanced loop route PLANNER -> WORKER-A // R2");
  assert.equal(concluded?.title, "Runtime concluded loop route // R3");
  assert.doesNotMatch(advanced?.title || "", /pipeline/i);
  assert.doesNotMatch(concluded?.title || "", /pipeline/i);
});

test("processEvent renders graph_dispatch as graph route flow", () => {
  resetDashboardState();
  dashboardSvg.buildRuntimeGraphSVG([
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

test("graph_dispatch animates a visible contract card along the route", () => {
  resetDashboardState();
  dashboardSvg.buildRuntimeGraphSVG([
    { id: "controller", role: "bridge", gateway: true, model: "m1" },
    { id: "planner", role: "planner", model: "m2" },
  ]);

  dashboard.processEvent("graph_dispatch", {
    from: "controller",
    to: "planner",
    contractId: "TC-GHOST-1",
    ts: 4,
  });

  const ghost = document.getElementById("runtimeGraphSvg").querySelector(".contract-flow-ghost");
  assert.ok(ghost, "expected ghost contract dispatch card");
  assert.equal(ghost.getAttribute("data-contract-id"), "TC-GHOST-1");
  assert.equal(ghost.getAttribute("class"), "contract-flow-ghost");
  assert.match(ghost.querySelector("animateMotion")?.getAttribute("dur") || "", /1\.[0-9]s/u);
});

test("dispatch runtime incoming contract lane renders from target runtime queue without work item assignee", () => {
  resetDashboardState();
  dashboardSvg.buildRuntimeGraphSVG([
    { id: "controller", role: "bridge", gateway: true, model: "m1" },
    { id: "planner", role: "planner", model: "m2" },
    { id: "worker-a", role: "executor", model: "m3" },
  ]);

  dashboard.processEvent("alert", {
    type: "dispatch_runtime_state",
    targets: {
      "worker-a": {
        busy: true,
        healthy: true,
        dispatching: false,
        currentContract: "TC-ACTIVE-1",
        queue: [
          { contractId: "TC-QUEUED-1", fromAgent: "planner", targetAgent: "worker-a" },
          { contractId: "TC-QUEUED-2", fromAgent: "planner", targetAgent: "worker-a" },
          { contractId: "TC-QUEUED-3", fromAgent: "planner", targetAgent: "worker-a" },
        ],
        lastSeen: 10,
      },
    },
    queue: [
      { contractId: "TC-QUEUED-1", fromAgent: "planner", targetAgent: "worker-a" },
      { contractId: "TC-QUEUED-2", fromAgent: "planner", targetAgent: "worker-a" },
      { contractId: "TC-QUEUED-3", fromAgent: "planner", targetAgent: "worker-a" },
    ],
    ts: 10,
  });

  const group = document.getElementById(dashboardSvg.eid("worker-a").qg);
  assert.equal(group.querySelectorAll(".contract-flow-card.lane-incoming").length, 3);
  assert.equal(group.querySelector(".contract-flow-overflow"), null);
  assert.deepEqual(
    group.querySelectorAll(".contract-flow-card.lane-incoming").map((card) => card.getAttribute("data-contract-id")).sort(),
    ["TC-QUEUED-1", "TC-QUEUED-2", "TC-QUEUED-3"],
  );
  assert.equal(group.querySelector(".contract-flow-card-label"), null);
});

test("dispatch runtime incoming contract lane aggregates folded gateway bridge queues", () => {
  resetDashboardState();
  dashboard.agentMeta.controller = { role: "bridge", gateway: true };
  dashboard.agentMeta["agent-for-kksl"] = { role: "bridge", gateway: true };
  dashboardSvg.buildRuntimeGraphSVG([
    { id: "controller", role: "bridge", gateway: true, model: "m1" },
    { id: "agent-for-kksl", role: "bridge", gateway: true, model: "m2" },
    { id: "planner", role: "planner", model: "m3" },
  ]);

  dashboard.processEvent("alert", {
    type: "dispatch_runtime_state",
    targets: {
      controller: {
        busy: false,
        healthy: true,
        dispatching: false,
        currentContract: null,
        queue: [{ contractId: "TC-CONTROLLER-Q", fromAgent: "planner", targetAgent: "controller" }],
        lastSeen: 20,
      },
      "agent-for-kksl": {
        busy: true,
        healthy: true,
        dispatching: false,
        currentContract: "TC-KKSL-ACTIVE",
        queue: [{ contractId: "TC-KKSL-Q", fromAgent: "planner", targetAgent: "agent-for-kksl" }],
        lastSeen: 21,
      },
    },
    queue: [
      { contractId: "TC-CONTROLLER-Q", fromAgent: "planner", targetAgent: "controller" },
      { contractId: "TC-KKSL-Q", fromAgent: "planner", targetAgent: "agent-for-kksl" },
    ],
    ts: 21,
  });

  const group = document.getElementById(dashboardSvg.eid("controller").qg);
  assert.equal(group.querySelectorAll(".contract-flow-card.lane-incoming").length, 2);
  assert.deepEqual(
    group.querySelectorAll(".contract-flow-card.lane-incoming").map((card) => card.getAttribute("data-contract-id")).sort(),
    ["TC-CONTROLLER-Q", "TC-KKSL-Q"],
  );
});

test("dispatch runtime queue stat ignores target-owned outgoingQueue residue", () => {
  resetDashboardState();
  dashboardSvg.buildRuntimeGraphSVG([
    { id: "planner", role: "planner", model: "m1" },
    { id: "worker-a", role: "executor", model: "m2" },
  ]);

  dashboard.processEvent("alert", {
    type: "dispatch_runtime_state",
    targets: {
      planner: {
        busy: false,
        healthy: true,
        dispatching: false,
        currentContract: null,
        outgoingQueue: [{ contractId: "TC-OUT", targetAgent: "worker-a" }],
        queue: [{ contractId: "TC-IN", fromAgent: "worker-a", targetAgent: "planner" }],
      },
      "worker-a": {
        busy: false,
        healthy: true,
        dispatching: false,
        currentContract: null,
        queue: [{ contractId: "TC-WORKER-IN", fromAgent: "planner", targetAgent: "worker-a" }],
      },
    },
    queue: [],
    ts: 22,
  });

  assert.equal(document.getElementById("statQueue").textContent, "2");
  const plannerGroup = document.getElementById(dashboardSvg.eid("planner").qg);
  assert.equal(plannerGroup.querySelector(".contract-flow-card.lane-outgoing"), null);
});

test("dispatch runtime queue stat and outgoing cards use canonical outgoingBySource", () => {
  resetDashboardState();
  dashboardSvg.buildRuntimeGraphSVG([
    { id: "planner", role: "planner", model: "m1" },
    { id: "worker-a", role: "executor", model: "m2" },
  ]);

  dashboard.processEvent("alert", {
    type: "dispatch_runtime_state",
    targets: {
      planner: {
        busy: false,
        healthy: true,
        dispatching: false,
        currentContract: null,
        queue: [],
      },
      "worker-a": {
        busy: false,
        healthy: true,
        dispatching: false,
        currentContract: null,
        queue: [],
      },
    },
    outgoingBySource: {
      planner: [{
        contractId: "TC-CANONICAL-OUT",
        fromAgent: "planner",
        targetAgent: "worker-a",
        status: "ready",
      }],
    },
    queue: [],
    ts: 22,
  });

  assert.equal(document.getElementById("statQueue").textContent, "1");
  const plannerGroup = document.getElementById(dashboardSvg.eid("planner").qg);
  const outgoingCard = plannerGroup.querySelector(".contract-flow-card.lane-outgoing");
  assert.equal(outgoingCard?.getAttribute("data-contract-id"), "TC-CANONICAL-OUT");
});

test("dispatch runtime queue stat ignores stale global queue when no runtime targets exist", () => {
  resetDashboardState();
  dashboardSvg.buildRuntimeGraphSVG([]);

  dashboard.processEvent("alert", {
    type: "dispatch_runtime_state",
    targets: {},
    queue: [{ contractId: "TC-STALE-GLOBAL" }],
    ts: 23,
  });

  assert.equal(document.getElementById("statQueue").textContent, "0");
});

test("loadAgentMeta redraws runtime contract lanes after rebuilding the SVG", async () => {
  resetDashboardState();
  dashboard.dispatchRuntimeState["worker-a"] = {
    busy: true,
    healthy: true,
    dispatching: false,
    currentContract: "TC-RUNNING-AFTER-META",
    queue: [{ contractId: "TC-QUEUED-AFTER-META", fromAgent: "planner", targetAgent: "worker-a" }],
  };

  globalThis.fetch = async (url) => {
    if (String(url).includes("/watchdog/agents")) {
      return {
        ok: true,
        async json() {
          return [
            { id: "planner", role: "planner", model: "m1" },
            { id: "worker-a", role: "executor", model: "m2" },
          ];
        },
      };
    }
    if (String(url).includes("/watchdog/models")) {
      return { ok: true, async json() { return []; } };
    }
    return { ok: false, async json() { return {}; } };
  };

  await dashboard.loadAgentMeta();

  const group = document.getElementById(dashboardSvg.eid("worker-a").qg);
  assert.equal(group.querySelectorAll(".contract-flow-card.lane-running").length, 1);
  assert.equal(group.querySelectorAll(".contract-flow-card.lane-incoming").length, 1);
});

test("dispatch runtime renders incoming outgoing and running contract cards in separate lanes", () => {
  resetDashboardState();
  dashboardSvg.buildRuntimeGraphSVG([
    { id: "planner", role: "planner", model: "m1" },
    { id: "worker-a", role: "executor", model: "m2" },
  ]);

  dashboard.processEvent("alert", {
    type: "dispatch_runtime_state",
    targets: {
      planner: {
        busy: true,
        healthy: true,
        dispatching: false,
        currentContract: "TC-RUNNING",
        queue: [{ contractId: "TC-INCOMING", fromAgent: "worker-a", targetAgent: "planner" }],
        lastSeen: 30,
      },
    },
    outgoingBySource: {
      planner: [{
        contractId: "TC-OUTGOING",
        fromAgent: "planner",
        targetAgent: "worker-a",
        status: "dispatching",
        routeEdge: { from: "planner", to: "worker-a", direction: "left_to_right" },
      }],
    },
    queue: [{ contractId: "TC-INCOMING", fromAgent: "worker-a", targetAgent: "planner" }],
    ts: 30,
  });

  const group = document.getElementById(dashboardSvg.eid("planner").qg);
  assert.equal(group.querySelectorAll(".contract-flow-card.lane-incoming").length, 1);
  assert.equal(group.querySelectorAll(".contract-flow-card.lane-outgoing").length, 1);
  assert.equal(group.querySelectorAll(".contract-flow-card.lane-running").length, 1);
  const runningCard = group.querySelector(".contract-flow-card.lane-running");
  const runningBox = runningCard?.querySelector(".contract-flow-card-box");
  assert.equal(runningBox?.getAttribute("width"), runningBox?.getAttribute("height"));

  const runningTransform = runningCard?.getAttribute("transform") || "";
  const runningX = Number(runningTransform.match(/translate\(([-\d.]+)/)?.[1]);
  const runningY = Number(runningTransform.match(/translate\([-\d.]+,([-\d.]+)/)?.[1]);
  const plannerPos = dashboardSvg.nodePositions.planner;
  assert.equal(runningY < plannerPos.y + plannerPos.h / 3, true);
  assert.equal(Math.abs((runningX + Number(runningBox?.getAttribute("width")) / 2) - (plannerPos.x + plannerPos.w / 2)) <= 1, true);
});

test("contract flow lane renders only visible queue cards and keeps details passive", () => {
  resetDashboardState();
  dashboardSvg.buildRuntimeGraphSVG([
    { id: "planner", role: "planner", model: "m1" },
  ]);

  dashboard.processEvent("alert", {
    type: "dispatch_runtime_state",
    targets: {
      planner: {
        busy: false,
        healthy: true,
        dispatching: false,
        currentContract: null,
        outgoingQueue: [],
        queue: [
          { contractId: "TC-Q-1", fromAgent: "controller", targetAgent: "planner" },
          { contractId: "TC-Q-2", fromAgent: "controller", targetAgent: "planner" },
          { contractId: "TC-Q-3", fromAgent: "controller", targetAgent: "planner" },
          { contractId: "TC-Q-4", fromAgent: "controller", targetAgent: "planner" },
          { contractId: "TC-Q-5", fromAgent: "controller", targetAgent: "planner" },
        ],
        lastSeen: 31,
      },
    },
    queue: [
      { contractId: "TC-Q-1", fromAgent: "controller", targetAgent: "planner" },
      { contractId: "TC-Q-2", fromAgent: "controller", targetAgent: "planner" },
      { contractId: "TC-Q-3", fromAgent: "controller", targetAgent: "planner" },
      { contractId: "TC-Q-4", fromAgent: "controller", targetAgent: "planner" },
      { contractId: "TC-Q-5", fromAgent: "controller", targetAgent: "planner" },
    ],
    ts: 31,
  });

  const group = document.getElementById(dashboardSvg.eid("planner").qg);
  assert.equal(group.querySelectorAll(".contract-flow-card.lane-incoming").length, 4);
  assert.equal(group.querySelector(".contract-flow-overflow")?.textContent, "+1");
  assert.equal(group.querySelector(".contract-flow-card-detail"), null);
  assert.equal(group.querySelectorAll("title").length, 4);
  assert.equal(typeof ContractCardView.prototype.renderDetail, "undefined");
});

test("contract flow lanes mirror incoming and outgoing sides for right-to-left graph edges", () => {
  resetDashboardState();
  dashboardSvg.buildRuntimeGraphSVG([
    { id: "planner", role: "planner", model: "m1" },
    { id: "worker-a", role: "executor", model: "m2" },
  ]);
  dashboardSvg.nodePositions.planner.x = 420;
  dashboardSvg.nodePositions["worker-a"].x = 40;
  window.__graphEdges = [{ from: "planner", to: "worker-a", gate: "default" }];

  dashboard.processEvent("alert", {
    type: "dispatch_runtime_state",
    targets: {
      planner: {
        busy: true,
        healthy: true,
        dispatching: false,
        currentContract: null,
        queue: [],
        lastSeen: 35,
      },
      "worker-a": {
        busy: true,
        healthy: true,
        dispatching: false,
        currentContract: null,
        outgoingQueue: [],
        queue: [{ contractId: "TC-RTL-IN", fromAgent: "planner", targetAgent: "worker-a" }],
        lastSeen: 35,
      },
    },
    outgoingBySource: {
      planner: [{
        contractId: "TC-RTL-OUT",
        fromAgent: "planner",
        targetAgent: "worker-a",
        status: "dispatching",
      }],
    },
    queue: [{ contractId: "TC-RTL-IN", fromAgent: "planner", targetAgent: "worker-a" }],
    ts: 35,
  });

  const plannerGroup = document.getElementById(dashboardSvg.eid("planner").qg);
  const workerGroup = document.getElementById(dashboardSvg.eid("worker-a").qg);
  const incomingTransform = workerGroup.querySelector(".contract-flow-card.lane-incoming")?.getAttribute("transform") || "";
  const outgoingTransform = plannerGroup.querySelector(".contract-flow-card.lane-outgoing")?.getAttribute("transform") || "";
  const incomingX = Number(incomingTransform.match(/translate\(([-\d.]+)/)?.[1]);
  const outgoingX = Number(outgoingTransform.match(/translate\(([-\d.]+)/)?.[1]);

  assert.equal(incomingX > dashboardSvg.nodePositions["worker-a"].x + dashboardSvg.nodePositions["worker-a"].w / 2, true);
  assert.equal(outgoingX < dashboardSvg.nodePositions.planner.x + dashboardSvg.nodePositions.planner.w / 2, true);
});

test("contract lane direction falls back to source and target geometry when graph edge state is absent", () => {
  resetDashboardState();
  dashboardSvg.buildRuntimeGraphSVG([
    { id: "planner", role: "planner", model: "m1" },
    { id: "worker-a", role: "executor", model: "m2" },
  ]);
  dashboardSvg.nodePositions.planner.x = 420;
  dashboardSvg.nodePositions["worker-a"].x = 40;
  window.__graphEdges = [];

  dashboard.processEvent("alert", {
    type: "dispatch_runtime_state",
    targets: {
      planner: {
        busy: true,
        healthy: true,
        dispatching: false,
        currentContract: null,
        queue: [],
        lastSeen: 35,
      },
      "worker-a": {
        busy: true,
        healthy: true,
        dispatching: false,
        currentContract: null,
        queue: [{ contractId: "TC-FALLBACK-IN", fromAgent: "planner", targetAgent: "worker-a" }],
        lastSeen: 35,
      },
    },
    outgoingBySource: {
      planner: [{
        contractId: "TC-FALLBACK-OUT",
        fromAgent: "planner",
        targetAgent: "worker-a",
        status: "dispatching",
      }],
    },
    queue: [{ contractId: "TC-FALLBACK-IN", fromAgent: "planner", targetAgent: "worker-a" }],
    ts: 35,
  });

  const plannerGroup = document.getElementById(dashboardSvg.eid("planner").qg);
  const workerGroup = document.getElementById(dashboardSvg.eid("worker-a").qg);
  const incomingTransform = workerGroup.querySelector(".contract-flow-card.lane-incoming")?.getAttribute("transform") || "";
  const outgoingTransform = plannerGroup.querySelector(".contract-flow-card.lane-outgoing")?.getAttribute("transform") || "";
  const incomingX = Number(incomingTransform.match(/translate\(([-\d.]+)/)?.[1]);
  const outgoingX = Number(outgoingTransform.match(/translate\(([-\d.]+)/)?.[1]);

  assert.equal(incomingX > dashboardSvg.nodePositions["worker-a"].x + dashboardSvg.nodePositions["worker-a"].w / 2, true);
  assert.equal(outgoingX < dashboardSvg.nodePositions.planner.x + dashboardSvg.nodePositions.planner.w / 2, true);
});

test("incoming contract lane uses queued source edge instead of unrelated target edges", () => {
  resetDashboardState();
  dashboardSvg.buildRuntimeGraphSVG([
    { id: "left-source", role: "agent", model: "m1" },
    { id: "worker-a", role: "executor", model: "m2" },
    { id: "right-source", role: "agent", model: "m3" },
  ]);
  dashboardSvg.nodePositions["left-source"].x = 40;
  dashboardSvg.nodePositions["worker-a"].x = 260;
  dashboardSvg.nodePositions["right-source"].x = 520;
  window.__graphEdges = [
    { from: "right-source", to: "worker-a", gate: "default" },
    { from: "left-source", to: "worker-a", gate: "default" },
  ];

  dashboard.processEvent("alert", {
    type: "dispatch_runtime_state",
    targets: {
      "worker-a": {
        busy: true,
        healthy: true,
        dispatching: false,
        currentContract: null,
        queue: [{ contractId: "TC-RIGHT-IN", fromAgent: "right-source", targetAgent: "worker-a" }],
        lastSeen: 36,
      },
    },
    queue: [{ contractId: "TC-RIGHT-IN", fromAgent: "right-source", targetAgent: "worker-a" }],
    ts: 36,
  });

  const group = document.getElementById(dashboardSvg.eid("worker-a").qg);
  const incomingTransform = group.querySelector(".contract-flow-card.lane-incoming")?.getAttribute("transform") || "";
  const incomingX = Number(incomingTransform.match(/translate\(([-\d.]+)/)?.[1]);

  assert.equal(incomingX > dashboardSvg.nodePositions["worker-a"].x + dashboardSvg.nodePositions["worker-a"].w / 2, true);
});

test("contract lane ignores queue routeEdge metadata that conflicts with runtime graph", () => {
  resetDashboardState();
  dashboardSvg.buildRuntimeGraphSVG([
    { id: "left-source", role: "agent", model: "m1" },
    { id: "worker-a", role: "executor", model: "m2" },
    { id: "right-source", role: "agent", model: "m3" },
  ]);
  dashboardSvg.nodePositions["left-source"].x = 40;
  dashboardSvg.nodePositions["worker-a"].x = 260;
  dashboardSvg.nodePositions["right-source"].x = 520;
  window.__graphEdges = [
    { from: "left-source", to: "worker-a", gate: "default" },
  ];

  dashboard.processEvent("alert", {
    type: "dispatch_runtime_state",
    targets: {
      "worker-a": {
        busy: true,
        healthy: true,
        dispatching: false,
        currentContract: null,
        queue: [{
          contractId: "TC-CONFLICTING-ROUTE-EDGE",
          fromAgent: "left-source",
          targetAgent: "worker-a",
          routeEdge: { from: "right-source", to: "worker-a" },
        }],
        lastSeen: 36,
      },
    },
    queue: [{ contractId: "TC-CONFLICTING-ROUTE-EDGE", fromAgent: "left-source", targetAgent: "worker-a" }],
    ts: 36,
  });

  const group = document.getElementById(dashboardSvg.eid("worker-a").qg);
  const incomingTransform = group.querySelector(".contract-flow-card.lane-incoming")?.getAttribute("transform") || "";
  const incomingX = Number(incomingTransform.match(/translate\(([-\d.]+)/)?.[1]);

  assert.equal(incomingX < dashboardSvg.nodePositions["worker-a"].x + dashboardSvg.nodePositions["worker-a"].w / 2, true);
});

test("mixed incoming contract queue keeps separate side stacks by source direction", () => {
  resetDashboardState();
  dashboardSvg.buildRuntimeGraphSVG([
    { id: "left-source", role: "agent", model: "m1" },
    { id: "worker-a", role: "executor", model: "m2" },
    { id: "right-source", role: "agent", model: "m3" },
  ]);
  dashboardSvg.nodePositions["left-source"].x = 40;
  dashboardSvg.nodePositions["worker-a"].x = 260;
  dashboardSvg.nodePositions["right-source"].x = 520;
  window.__graphEdges = [
    { from: "left-source", to: "worker-a", gate: "default" },
    { from: "right-source", to: "worker-a", gate: "default" },
  ];

  dashboard.processEvent("alert", {
    type: "dispatch_runtime_state",
    targets: {
      "worker-a": {
        busy: true,
        healthy: true,
        dispatching: false,
        currentContract: null,
        queue: [
          { contractId: "TC-LEFT-IN", fromAgent: "left-source", targetAgent: "worker-a" },
          { contractId: "TC-RIGHT-IN", fromAgent: "right-source", targetAgent: "worker-a" },
        ],
        lastSeen: 37,
      },
    },
    queue: [
      { contractId: "TC-LEFT-IN", fromAgent: "left-source", targetAgent: "worker-a" },
      { contractId: "TC-RIGHT-IN", fromAgent: "right-source", targetAgent: "worker-a" },
    ],
    ts: 37,
  });

  const group = document.getElementById(dashboardSvg.eid("worker-a").qg);
  const transforms = Object.fromEntries(
    group.querySelectorAll(".contract-flow-card.lane-incoming")
      .map((card) => [
        card.getAttribute("data-contract-id"),
        Number((card.getAttribute("transform") || "").match(/translate\(([-\d.]+)/)?.[1]),
      ]),
  );

  assert.equal(transforms["TC-LEFT-IN"] < dashboardSvg.nodePositions["worker-a"].x + dashboardSvg.nodePositions["worker-a"].w / 2, true);
  assert.equal(transforms["TC-RIGHT-IN"] > dashboardSvg.nodePositions["worker-a"].x + dashboardSvg.nodePositions["worker-a"].w / 2, true);
});

test("contract flow card click focuses matching lifecycle work item", () => {
  resetDashboardState();
  dashboardSvg.buildRuntimeGraphSVG([
    { id: "worker-a", role: "executor", model: "m1" },
  ]);
  dashboard.mergeWorkItemState("TC-FOCUS", {
    id: "TC-FOCUS",
    hasContract: true,
    task: "focus this work item",
    status: "pending",
    createdAt: 1,
  });
  dashboard.renderWorkItems();

  dashboard.processEvent("alert", {
    type: "dispatch_runtime_state",
    targets: {
      "worker-a": {
        busy: false,
        healthy: true,
        dispatching: false,
        currentContract: null,
        queue: [{ contractId: "TC-FOCUS", fromAgent: "planner", targetAgent: "worker-a" }],
        lastSeen: 40,
      },
    },
    queue: [{ contractId: "TC-FOCUS", fromAgent: "planner", targetAgent: "worker-a" }],
    ts: 40,
  });

  const flowCard = document.getElementById(dashboardSvg.eid("worker-a").qg).querySelector(".contract-flow-card");
  assert.ok(flowCard, "expected contract flow card");
  flowCard.onclick?.({ stopPropagation() {} });

  assert.equal(document.getElementById("workItemList").querySelector(".work-item-card.focused") !== null, true);
});

test("inbox_dispatch animates a visible contract card along the route", () => {
  resetDashboardState();
  dashboardSvg.buildRuntimeGraphSVG([
    { id: "planner", role: "planner", model: "m1" },
    { id: "worker-a", role: "executor", model: "m2" },
  ]);

  dashboard.processEvent("alert", {
    type: "inbox_dispatch",
    from: "planner",
    assignee: "worker-a",
    contractId: "TC-GHOST-2",
    task: "dispatch contract",
    protocolEnvelope: "execution_contract",
    ts: 41,
  });

  const ghost = document.getElementById("runtimeGraphSvg").querySelector(".contract-flow-ghost");
  assert.ok(ghost, "expected ghost contract dispatch card");
  assert.equal(ghost.getAttribute("data-contract-id"), "TC-GHOST-2");
  assert.match(ghost.querySelector("animateMotion")?.getAttribute("dur") || "", /1\.[0-9]s/u);
});

test("paired inbox and graph dispatch keep one live ghost for the same contract route", () => {
  resetDashboardState();
  dashboardSvg.buildRuntimeGraphSVG([
    { id: "planner", role: "planner", model: "m1" },
    { id: "worker-a", role: "executor", model: "m2" },
  ]);

  let now = 1000;
  const originalDateNow = Date.now;
  Date.now = () => now;
  try {
    dashboard.processEvent("alert", {
      type: "inbox_dispatch",
      from: "planner",
      assignee: "worker-a",
      contractId: "TC-GHOST-DEDUP",
      protocolEnvelope: "execution_contract",
      ts: 41,
    });
    now += 1300;
    dashboard.processEvent("graph_dispatch", {
      from: "planner",
      to: "worker-a",
      contractId: "TC-GHOST-DEDUP",
      ts: 42,
    });
  } finally {
    Date.now = originalDateNow;
  }

  const ghosts = document.getElementById("runtimeGraphSvg").querySelectorAll(".contract-flow-ghost");
  assert.equal(ghosts.length, 1);
  assert.equal(ghosts[0].getAttribute("data-contract-id"), "TC-GHOST-DEDUP");
});

test("contract ghost dedupe covers the full live ghost lifetime", () => {
  resetDashboardState();
  dashboardSvg.buildRuntimeGraphSVG([
    { id: "planner", role: "planner", model: "m1" },
    { id: "worker-a", role: "executor", model: "m2" },
  ]);

  let now = 2000;
  const originalDateNow = Date.now;
  Date.now = () => now;
  try {
    const animator = new ContractFlowAnimator();
    animator.animateGhost("planner", "worker-a", "TC-GHOST-LIVE-DEDUP");
    now += 1300;
    animator.animateGhost("planner", "worker-a", "TC-GHOST-LIVE-DEDUP");
  } finally {
    Date.now = originalDateNow;
  }

  const ghosts = document.getElementById("runtimeGraphSvg").querySelectorAll(".contract-flow-ghost");
  assert.equal(ghosts.length, 1);
  assert.equal(ghosts[0].getAttribute("data-contract-id"), "TC-GHOST-LIVE-DEDUP");
});

test("processEvent keeps delivery return flow on reply lane", () => {
  resetDashboardState();
  dashboardSvg.buildRuntimeGraphSVG([
    { id: "controller", role: "bridge", gateway: true, model: "m1" },
    { id: "worker-a", role: "executor", model: "m2" },
  ]);
  window.__graphEdges = [];

  dashboard.processEvent("track_end", {
    agentId: "worker-a",
    status: "completed",
    replyTo: { agentId: "controller" },
    runtimeDiagnostics: {
      terminalDelivery: {
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

test("hidden system-control graph edges do not suppress visible terminal delivery flow", () => {
  resetDashboardState();
  dashboardSvg.buildRuntimeGraphSVG([
    { id: "controller", role: "bridge", gateway: true, model: "m1" },
    { id: "worker-a", role: "executor", model: "m2" },
    { id: "operator", role: "agent", systemControl: true, model: "m3" },
  ]);
  window.__graphEdges = [{ from: "worker-a", to: "operator", gate: "system-control" }];

  dashboard.processEvent("track_end", {
    agentId: "worker-a",
    status: "completed",
    replyTo: { agentId: "controller" },
    runtimeDiagnostics: {
      terminalDelivery: {
        ok: true,
        channel: "qq",
        workflow: "delivery:terminal",
      },
    },
    ts: 4,
  });

  const flow = findFlowGroup("worker-a→controller");
  assert.ok(flow, "expected hidden control edge to be ignored for visible terminal delivery");
  assert.match(getFlowPathClass(flow), /flow-terminal-delivery/);
});

test("loadGraph exposes normalized graph edges without synthesizing track_start route flows", async () => {
  resetDashboardState();
  dashboard.agentMeta.controller = { role: "bridge", gateway: true };
  dashboard.agentMeta["agent-for-kksl"] = { role: "bridge", gateway: true };
  dashboardSvg.buildRuntimeGraphSVG([
    { id: "controller", role: "bridge", gateway: true, model: "m1" },
    { id: "agent-for-kksl", role: "bridge", gateway: true, model: "m2" },
    { id: "planner", role: "planner", model: "m3" },
  ]);

  globalThis.fetch = async (url) => {
    if (String(url).includes("/watchdog/graph")) {
      return {
        ok: true,
        async json() {
          return {
            edges: [{ from: "agent-for-kksl", to: "planner", gate: "default" }],
            cycles: [],
            loops: [],
            loopSessions: [],
            activeLoopSession: null,
          };
        },
      };
    }
    return { ok: false, async json() { return {}; } };
  };

  await dashboardGraph.loadGraph();

  assert.deepEqual(window.__graphEdges, [{ from: "controller", to: "planner", gate: "default" }]);
  dashboard.processEvent("track_start", {
    agentId: "planner",
    workItemId: "TC-NORMALIZED-GRAPH",
    task: "normalized graph route",
    ts: 7,
  });

  assert.equal(findFlowGroup("controller→planner"), null);
  assert.equal(findFlowGroup("agent-for-kksl→planner"), null);
});

test("track_start alone does not create replyTo fallback route flows", () => {
  resetDashboardState();
  dashboardSvg.buildRuntimeGraphSVG([
    { id: "controller", role: "bridge", gateway: true, model: "m1" },
    { id: "planner", role: "planner", model: "m2" },
  ]);
  window.__graphEdges = [];

  dashboard.processEvent("track_start", {
    agentId: "planner",
    workItemId: "TC-TRACK-START-REPLY",
    task: "track start should not draw",
    replyTo: { agentId: "controller" },
    ts: 8,
  });

  assert.equal(findFlowGroup("controller→planner"), null);
});

test("loadGraph keeps OC graph mirror synchronized with canonical graph edge state", async () => {
  resetDashboardState();
  OC.graph = { graphEdges: [{ from: "stale", to: "edge" }] };
  dashboardSvg.buildRuntimeGraphSVG([
    { id: "controller", role: "bridge", gateway: true, model: "m1" },
    { id: "planner", role: "planner", model: "m2" },
  ]);

  globalThis.fetch = async (url) => {
    if (String(url).includes("/watchdog/graph")) {
      return {
        ok: true,
        async json() {
          return {
            edges: [{ from: "controller", to: "planner", gate: "default" }],
            cycles: [],
            loops: [],
            loopSessions: [],
            activeLoopSession: null,
          };
        },
      };
    }
    return { ok: false, async json() { return {}; } };
  };

  await dashboardGraph.loadGraph();

  assert.deepEqual(OC.graph.graphEdges, [{ from: "controller", to: "planner", gate: "default" }]);
  assert.equal(OC.graph.graphEdges, window.__graphEdges);
});

test("loadGraph preserves edge truth when graph nodes are not visible yet", async () => {
  resetDashboardState();
  window._visibleRuntimeGraphAgentIds = [];

  globalThis.fetch = async (url) => {
    if (String(url).includes("/watchdog/graph")) {
      return {
        ok: true,
        async json() {
          return {
            edges: [{ from: "controller", to: "planner", gate: "default" }],
            cycles: [],
            loops: [],
            loopSessions: [],
            activeLoopSession: null,
          };
        },
      };
    }
    return { ok: false, async json() { return {}; } };
  };

  await dashboardGraph.loadGraph();

  assert.deepEqual(window.__graphEdges, [{ from: "controller", to: "planner", gate: "default" }]);
});

test("renderGraphEdges does not duplicate replacement edges when one edge lacks temporary geometry", async () => {
  resetDashboardState();
  dashboardSvg.buildRuntimeGraphSVG([
    { id: "controller", role: "bridge", gateway: true, model: "m1" },
    { id: "planner", role: "planner", model: "m2" },
    { id: "worker-a", role: "executor", model: "m3" },
  ]);

  globalThis.fetch = async (url) => {
    if (String(url).includes("/watchdog/graph")) {
      return {
        ok: true,
        async json() {
          return {
            edges: [
              { from: "controller", to: "planner", gate: "default" },
              { from: "planner", to: "worker-a", gate: "default" },
            ],
            cycles: [],
            loops: [],
            loopSessions: [],
            activeLoopSession: null,
          };
        },
      };
    }
    return { ok: false, async json() { return {}; } };
  };

  await dashboardGraph.loadGraph();
  delete dashboardSvg.nodePositions["worker-a"];
  dashboardGraph.renderGraphEdges();

  const svg = document.getElementById("runtimeGraphSvg");
  assert.equal(svg.querySelectorAll('[data-graph-edge="controller→planner"]').length, 1);
  assert.equal(svg.querySelectorAll('[data-graph-edge="planner→worker-a"]').length, 1);
});

test("renderGraphEdges keeps existing lines when node geometry is temporarily unavailable", async () => {
  resetDashboardState();
  dashboardSvg.buildRuntimeGraphSVG([
    { id: "controller", role: "bridge", gateway: true, model: "m1" },
    { id: "planner", role: "planner", model: "m2" },
  ]);

  globalThis.fetch = async (url) => {
    if (String(url).includes("/watchdog/graph")) {
      return {
        ok: true,
        async json() {
          return {
            edges: [{ from: "controller", to: "planner", gate: "default" }],
            cycles: [],
            loops: [],
            loopSessions: [],
            activeLoopSession: null,
          };
        },
      };
    }
    return { ok: false, async json() { return {}; } };
  };

  await dashboardGraph.loadGraph();
  assert.ok(document.getElementById("runtimeGraphSvg").querySelector('[data-graph-edge="controller→planner"]'));

  for (const key of Object.keys(dashboardSvg.nodePositions)) {
    delete dashboardSvg.nodePositions[key];
  }

  dashboardGraph.renderGraphEdges();

  assert.ok(
    document.getElementById("runtimeGraphSvg").querySelector('[data-graph-edge="controller→planner"]'),
    "existing graph edge should remain visible until replacement geometry is ready",
  );
});

test("graph_dispatch emitted before node geometry is drawn appears after graph rebuild", () => {
  resetDashboardState();

  dashboard.processEvent("graph_dispatch", {
    from: "controller",
    to: "planner",
    contractId: "TC-PENDING-FLOW",
    ts: 4,
  });
  assert.equal(findFlowGroup("controller→planner"), null);

  dashboardSvg.buildRuntimeGraphSVG([
    { id: "controller", role: "bridge", gateway: true, model: "m1" },
    { id: "planner", role: "planner", model: "m2" },
  ]);

  assert.ok(findFlowGroup("controller→planner"), "expected pending flow to render after geometry became available");
});

test("systemReset clears active flow residue and edit-mode add-agent dialog", async () => {
  resetDashboardState();
  dashboardSvg.buildRuntimeGraphSVG([
    { id: "controller", role: "bridge", gateway: true, model: "m1" },
    { id: "planner", role: "planner", model: "m2" },
  ]);
  dashboard.addActiveFlow("controller", "planner", "ROUTE", { type: "graph-route" });
  assert.ok(findFlowGroup("controller→planner"));
  OC.ux.editMode = true;
  dashboardUx.showAddAgentDialog();
  assert.ok(document.body.querySelector("#addAgentDialog"));

  globalThis.confirm = () => true;
  globalThis.fetch = async (url) => {
    if (String(url).includes("/watchdog/reset")) {
      return {
        ok: true,
        async json() { return { ok: true }; },
      };
    }
    return { ok: false, async json() { return {}; } };
  };

  await dashboard.systemReset();

  assert.equal(findFlowGroup("controller→planner"), null);
  assert.equal(document.body.querySelector("#addAgentDialog"), null);
});

test("leaving edit mode clears add-agent dialog residue", () => {
  resetDashboardState();
  OC.ux.editMode = true;
  document.body.classList.add("edit-mode");
  dashboardUx.showAddAgentDialog();
  assert.ok(document.body.querySelector("#addAgentDialog"));

  dashboardUx.toggleEditMode();

  assert.equal(OC.ux.editMode, false);
  assert.equal(document.body.querySelector("#addAgentDialog"), null);
});

test("processEvent does not render terminal reply lane for system_action return-only completion", () => {
  resetDashboardState();
  dashboardSvg.buildRuntimeGraphSVG([
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
        system_action_runtime_result: {
          handled: true,
          workflow: "delivery:system_action_runtime_result",
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
  dashboardSvg.buildRuntimeGraphSVG([
    { id: "planner", role: "planner", model: "m1" },
    { id: "worker-a", role: "executor", model: "m2" },
  ]);

  dashboard.processEvent("alert", {
    type: "system_action_runtime_result_delivered",
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

test("loadDispatchRuntimeState renders running contract lane from runtime snapshot on initial load", async () => {
  resetDashboardState();
  dashboardSvg.buildRuntimeGraphSVG([
    { id: "planner", role: "planner", model: "m1" },
    { id: "worker-a", role: "executor", model: "m2" },
  ]);

  globalThis.fetch = async (url) => {
    if (String(url).includes('/watchdog/runtime')) {
      return {
        ok: true,
        async json() {
          return {
            dispatchQueue: { contractIds: [] },
            dispatchRuntime: {
              targets: {
                "worker-a": {
                  busy: true,
                  healthy: true,
                  dispatching: false,
                  currentContract: "TC-RUNNING-ID",
                },
              },
            },
          };
        },
      };
    }
    return { ok: false, async json() { return {}; } };
  };

  await dashboard.loadDispatchRuntimeState();

  const group = document.getElementById(dashboardSvg.eid("worker-a").qg);
  assert.equal(group.querySelectorAll(".contract-flow-card.lane-running").length, 1);
  assert.equal(group.querySelector(".contract-flow-card.lane-running")?.getAttribute("data-contract-id"), "TC-RUNNING-ID");
});

test("dispatch runtime SSE snapshot normalizes currentContractId like polling snapshots", () => {
  resetDashboardState();
  dashboardSvg.buildRuntimeGraphSVG([
    { id: "worker-a", role: "executor", model: "m1" },
  ]);

  dashboard.processEvent("alert", {
    type: "dispatch_runtime_state",
    targets: {
      "worker-a": {
        busy: true,
        healthy: true,
        dispatching: false,
        currentContractId: "TC-SSE-RUNNING-ID",
        queue: [],
      },
    },
    queue: [],
  });

  assert.equal(dashboard.dispatchRuntimeState["worker-a"].currentContract, "TC-SSE-RUNNING-ID");
  const group = document.getElementById(dashboardSvg.eid("worker-a").qg);
  assert.equal(group.querySelector(".contract-flow-card.lane-running")?.getAttribute("data-contract-id"), "TC-SSE-RUNNING-ID");
});

test("loadWorkItems does not let an older polling snapshot delete a fresh SSE work item", async () => {
  resetDashboardState();
  dashboard.processEvent("track_start", {
    agentId: "worker-a",
    workItemId: "TC-FRESH-SSE",
    task: "fresh SSE work item",
    status: "running",
    hasContract: true,
    ts: Date.now(),
  });
  assert.equal(Boolean(dashboard.workItems["TC-FRESH-SSE"]), true);

  globalThis.fetch = async (url) => {
    if (String(url).includes("/watchdog/work-items")) {
      return {
        ok: true,
        async json() {
          return [];
        },
      };
    }
    return { ok: false, async json() { return {}; } };
  };

  await dashboard.loadWorkItems();

  assert.equal(Boolean(dashboard.workItems["TC-FRESH-SSE"]), true);
});

test("loadWorkItems filters control-layer work items from the main dashboard", async () => {
  resetDashboardState();

  globalThis.fetch = async (url) => {
    if (String(url).includes("/watchdog/work-items")) {
      return {
        ok: true,
        async json() {
          return [
            {
              id: "TC-CONTROL-WORK",
              agentId: "operator",
              task: "operator control plane task",
              status: "running",
              mainViewVisible: false,
            },
            {
              id: "TC-VISIBLE-WORK",
              agentId: "worker-a",
              task: "visible worker task",
              status: "running",
              mainViewVisible: true,
            },
          ];
        },
      };
    }
    return { ok: false, async json() { return {}; } };
  };

  await dashboard.loadWorkItems();

  assert.equal(Boolean(dashboard.workItems["TC-CONTROL-WORK"]), false);
  assert.equal(Boolean(dashboard.workItems["TC-VISIBLE-WORK"]), true);
});

test("dispatch runtime SSE snapshot replaces pruned targets instead of merging stale queue lanes", () => {
  resetDashboardState();
  dashboardSvg.buildRuntimeGraphSVG([
    { id: "planner", role: "planner", model: "m1" },
    { id: "worker-a", role: "executor", model: "m2" },
  ]);

  dashboard.processEvent("alert", {
    type: "dispatch_runtime_state",
    targets: {
      "worker-a": {
        busy: false,
        healthy: true,
        dispatching: false,
        currentContract: null,
        queue: [{ contractId: "TC-STALE", fromAgent: "planner", targetAgent: "worker-a" }],
      },
    },
    queue: [{ contractId: "TC-STALE", fromAgent: "planner", targetAgent: "worker-a" }],
  });
  assert.equal("worker-a" in dashboard.dispatchRuntimeState, true);

  dashboard.processEvent("alert", {
    type: "dispatch_runtime_state",
    targets: {},
    queue: [],
  });

  assert.equal("worker-a" in dashboard.dispatchRuntimeState, false);
  const group = document.getElementById(dashboardSvg.eid("worker-a").qg);
  assert.equal(group.querySelectorAll(".contract-flow-card").length, 0);
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

test("renderWorkItems does not consume render hash while work item host is missing", () => {
  resetDashboardState();

  dashboard.mergeWorkItemState("C-HOST", {
    task: "render after host returns",
    assignee: "researcher",
    status: "running",
    createdAt: 2,
    updatedAt: 2,
    pct: 34,
    toolCallCount: 1,
    phases: ["恢复工作项容器"],
    stageProjection: { source: "task_stage_truth" },
  });

  const workItemHost = document.elements.get("workItemList");
  document.missingElementIds.add("workItemList");
  dashboard.renderWorkItems();

  document.missingElementIds.delete("workItemList");
  document.elements.set("workItemList", workItemHost);
  dashboard.renderWorkItems();

  assert.match(document.getElementById("workItemList").innerHTML, /恢复工作项容器/);
});

test("renderWorkItems prefers agent-local activity progress over canonical phases for the main progress UI", () => {
  resetDashboardState();

  dashboard.mergeWorkItemState("C-LOCAL-1", {
    task: "研究任务",
    assignee: "worker1",
    status: "running",
    createdAt: 10,
    updatedAt: 10,
    pct: 0,
    cursor: "0/3",
    activityProgress: {
      source: "agent_local_activity",
      phases: ["接手", "执行", "收口"],
      completedPhases: [],
      currentPhase: "接手",
      currentPhaseIndex: 0,
      cursor: "0/3",
      pct: 0,
      total: 3,
    },
    phases: ["收集证据", "形成结论"],
    stagePlan: {
      contractId: "C-LOCAL-1",
      stages: [
        { id: "stage-1", label: "收集证据", semanticLabel: "收集证据", status: "completed" },
        { id: "stage-2", label: "形成结论", semanticLabel: "形成结论", status: "active" },
      ],
      revisionPolicy: { maxRevisions: 2, maxStageDelta: 1 },
    },
  });

  dashboard.renderWorkItems();

  const html = document.getElementById("workItemList").innerHTML;
  assert.match(html, /接手/);
  assert.doesNotMatch(html, /收集证据/);
});

test("processEvent resets visible progress when a contract hands off to a new agent", () => {
  resetDashboardState();

  dashboard.processEvent("track_progress", {
    agentId: "worker1",
    sessionKey: "agent:worker1:handoff",
    hasContract: true,
    contractId: "C-LOCAL-HANDOFF",
    task: "研究任务",
    status: "running",
    assignee: "worker1",
    pct: 80,
    cursor: "2/3",
    activityProgress: {
      source: "agent_local_activity",
      phases: ["接手", "执行", "收口"],
      completedPhases: ["接手", "执行"],
      currentPhase: "收口",
      currentPhaseIndex: 2,
      cursor: "2/3",
      pct: 80,
      total: 3,
    },
    phases: ["收集证据", "形成结论"],
    ts: 11,
  });

  dashboard.processEvent("track_start", {
    agentId: "worker2",
    sessionKey: "agent:worker2:handoff",
    hasContract: true,
    contractId: "C-LOCAL-HANDOFF",
    task: "研究任务",
    status: "running",
    assignee: "worker2",
    pct: 0,
    cursor: "0/3",
    activityProgress: {
      source: "agent_local_activity",
      phases: ["接手", "执行", "收口"],
      completedPhases: [],
      currentPhase: "接手",
      currentPhaseIndex: 0,
      cursor: "0/3",
      pct: 0,
      total: 3,
    },
    phases: ["收集证据", "形成结论"],
    ts: 12,
  });

  assert.equal(dashboard.workItems["C-LOCAL-HANDOFF"]?.assignee, "worker2");
  assert.equal(dashboard.workItems["C-LOCAL-HANDOFF"]?.pct, 0);
  assert.equal(dashboard.workItems["C-LOCAL-HANDOFF"]?.activityProgress?.currentPhase, "接手");
  assert.match(document.getElementById("workItemList").innerHTML, /接手/);
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
