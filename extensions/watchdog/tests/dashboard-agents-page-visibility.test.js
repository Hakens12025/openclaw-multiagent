import test from "node:test";
import assert from "node:assert/strict";

let importCounter = 0;

function nextImportTag() {
  importCounter += 1;
  return `${Date.now()}-${process.pid}-${importCounter}`;
}

class MockElement {
  constructor(tagName = "div") {
    this.tagName = String(tagName).toUpperCase();
    this.children = [];
    this.className = "";
    this.id = "";
    this.attributes = {};
    this._innerHTML = "";
    this._textContent = "";
    this.listeners = new Map();
    this.queryCache = new Map();
  }

  appendChild(child) {
    this.children.push(child);
    child.parentNode = this;
    return child;
  }

  querySelector(selector) {
    for (const child of this.children) {
      if (child.matches?.(selector)) return child;
      const nested = child.querySelector?.(selector);
      if (nested) return nested;
    }
    if (selector === ".subpage-toolbar" && this._innerHTML.includes("subpage-toolbar")) {
      const toolbar = new MockElement("div");
      toolbar.className = "subpage-toolbar";
      this.appendChild(toolbar);
      return toolbar;
    }
    if (selector === "[data-agent-open-modal]" && this._innerHTML.includes("data-agent-open-modal")) {
      const button = new MockElement("button");
      button.setAttribute("data-agent-open-modal", "1");
      this.appendChild(button);
      return button;
    }
    if (selector === "[data-agent-refresh]" && this._innerHTML.includes("data-agent-refresh")) {
      const button = new MockElement("button");
      button.setAttribute("data-agent-refresh", "1");
      this.appendChild(button);
      return button;
    }
    return null;
  }

  querySelectorAll(selector) {
    const cacheKey = `${selector}::${this._innerHTML}`;
    if (this.queryCache.has(cacheKey)) return this.queryCache.get(cacheKey);
    if (selector === "[data-agent-detail]") {
      const matches = [];
      const pattern = /data-agent-detail(?:="([^"]*)")?/gu;
      for (const match of this._innerHTML.matchAll(pattern)) {
        if (!match[1]) continue;
        const button = new MockElement("button");
        button.setAttribute("data-agent-detail", match[1]);
        matches.push(button);
      }
      this.queryCache.set(cacheKey, matches);
      return matches;
    }
    if (selector === "[data-agent-preview]") {
      const matches = [];
      const pattern = /data-agent-preview(?:="([^"]*)")?[\s\S]*?data-agent-preview-file(?:="([^"]*)")?/gu;
      for (const match of this._innerHTML.matchAll(pattern)) {
        if (!match[1] || !match[2]) continue;
        const button = new MockElement("button");
        button.setAttribute("data-agent-preview", match[1]);
        button.setAttribute("data-agent-preview-file", match[2]);
        matches.push(button);
      }
      this.queryCache.set(cacheKey, matches);
      return matches;
    }
    const matches = [];
    this.queryCache.set(cacheKey, matches);
    return matches;
  }

  matches(selector) {
    if (selector?.startsWith(".")) {
      return String(this.className || "").split(/\s+/u).includes(selector.slice(1));
    }
    if (selector?.startsWith("[") && selector.endsWith("]")) {
      const [rawName, rawValue] = selector.slice(1, -1).split("=");
      const name = String(rawName || "").trim();
      const expected = rawValue?.replace(/^"|"$/gu, "");
      return expected == null ? this.attributes[name] !== undefined : this.attributes[name] === expected;
    }
    return false;
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  getAttribute(name) {
    return this.attributes[name] || null;
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }

  click() {
    for (const listener of this.listeners.get("click") || []) {
      listener({ preventDefault() {}, stopPropagation() {} });
    }
  }

  get innerHTML() {
    return this._innerHTML;
  }

  set innerHTML(value) {
    this._innerHTML = String(value ?? "");
    this.queryCache.clear();
  }

  get textContent() {
    return this._textContent;
  }

  set textContent(value) {
    this._textContent = String(value ?? "");
    this._innerHTML = String(value ?? "");
  }
}

class MockDocument {
  constructor() {
    this.elements = new Map();
    this.body = new MockElement("body");
  }

  createElement(tagName) {
    return new MockElement(tagName);
  }

  getElementById(id) {
    if (!this.elements.has(id)) {
      const element = new MockElement("div");
      element.id = id;
      this.elements.set(id, element);
    }
    return this.elements.get(id);
  }

  querySelector(selector) {
    if (selector === "#pageChrome .subpage-toolbar") {
      return this.getElementById("pageChrome").querySelector(".subpage-toolbar");
    }
    return null;
  }

  querySelectorAll() {
    return [];
  }
}

const originalGlobals = {
  document: globalThis.document,
  window: globalThis.window,
  fetch: globalThis.fetch,
  requestAnimationFrame: globalThis.requestAnimationFrame,
  setInterval: globalThis.setInterval,
  setTimeout: globalThis.setTimeout,
};

async function waitForCondition(predicate, attempts = 20) {
  for (let i = 0; i < attempts; i += 1) {
    if (predicate()) return true;
    await new Promise((resolve) => setImmediate(resolve));
  }
  return false;
}

test("agents page roster hides control actors with the shared main-view visibility policy", async (t) => {
  const document = new MockDocument();
  for (const id of ["agentsExperience", "pageChrome", "navBar", "headerTime", "headerDate"]) {
    document.getElementById(id);
  }

  globalThis.document = document;
  globalThis.window = {
    location: { pathname: "/watchdog/agents-view", search: "", reload() {} },
    setInterval() {
      return 1;
    },
  };
  globalThis.requestAnimationFrame = (callback) => {
    if (typeof callback === "function") callback();
    return 1;
  };
  globalThis.setInterval = () => 1;
  globalThis.setTimeout = () => 1;
  globalThis.fetch = async (url) => {
    const path = String(url);
    if (path.startsWith("/watchdog/agents/discovery")) {
      return {
        ok: true,
        async text() {
          return JSON.stringify({
            agents: [
              { id: "controller", role: "bridge", gateway: true, status: "managed", source: "configured" },
              { id: "operator", role: "agent", status: "managed", source: "configured" },
              { id: "harness", role: "agent", status: "managed", source: "configured" },
              { id: "cli-system", role: "agent", status: "managed", source: "configured" },
              { id: "automation", role: "agent", status: "managed", source: "configured" },
              { id: "planner", role: "planner", status: "managed", source: "configured" },
              { id: "worker", role: "executor", status: "managed", source: "configured" },
            ],
            candidates: [],
            candidateCounts: {},
            localWorkspaceResidue: [],
            localWorkspaceResidueCounts: {},
            counts: { configured: 7, managed: 7 },
          });
        },
      };
    }
    if (path.startsWith("/watchdog/agents")) {
      return {
        ok: true,
        async text() {
          return JSON.stringify([]);
        },
      };
    }
    return {
      ok: false,
      async text() {
        return "";
      },
    };
  };

  t.after(() => {
    globalThis.document = originalGlobals.document;
    globalThis.window = originalGlobals.window;
    globalThis.fetch = originalGlobals.fetch;
    globalThis.requestAnimationFrame = originalGlobals.requestAnimationFrame;
    globalThis.setInterval = originalGlobals.setInterval;
    globalThis.setTimeout = originalGlobals.setTimeout;
  });

  await import(`../dashboard-agents.js?test=${nextImportTag()}`);
  await new Promise((resolve) => setImmediate(resolve));

  const html = document.getElementById("agentsExperience").innerHTML;
  assert.match(html, /data-agent-id="controller"/u);
  assert.match(html, /data-agent-id="planner"/u);
  assert.match(html, /data-agent-id="worker"/u);
  assert.doesNotMatch(html, /data-agent-id="operator"/u);
  assert.doesNotMatch(html, /data-agent-id="harness"/u);
  assert.doesNotMatch(html, /data-agent-id="cli-system"/u);
  assert.doesNotMatch(html, /data-agent-id="automation"/u);
});

test("agents page candidate count uses the same main-view filter as the modal", async (t) => {
  const document = new MockDocument();
  for (const id of ["agentsExperience", "pageChrome", "navBar", "headerTime", "headerDate"]) {
    document.getElementById(id);
  }

  globalThis.document = document;
  globalThis.window = {
    location: { pathname: "/watchdog/agents-view", search: "", reload() {} },
    setInterval() {
      return 1;
    },
  };
  globalThis.requestAnimationFrame = (callback) => {
    if (typeof callback === "function") callback();
    return 1;
  };
  globalThis.setInterval = () => 1;
  globalThis.setTimeout = () => 1;
  globalThis.fetch = async (url) => {
    const path = String(url);
    if (path.startsWith("/watchdog/agents/discovery")) {
      return {
        ok: true,
        async text() {
          return JSON.stringify({
            agents: [],
            candidates: [
              { id: "operator", role: "agent", status: "discovered", source: "configured", joinable: true },
              { id: "worker-new", role: "executor", status: "discovered", source: "configured", joinable: true },
            ],
            candidateCounts: { total: 3, configured: 2, localWorkspace: 1 },
            localWorkspaceResidue: [
              { id: "automation", role: "agent", status: "discovered", source: "local_workspace", joinable: true },
            ],
            localWorkspaceResidueCounts: {},
            counts: { configured: 0, managed: 0 },
          });
        },
      };
    }
    if (path.startsWith("/watchdog/agents")) {
      return {
        ok: true,
        async text() {
          return JSON.stringify([]);
        },
      };
    }
    return {
      ok: false,
      async text() {
        return "";
      },
    };
  };

  t.after(() => {
    globalThis.document = originalGlobals.document;
    globalThis.window = originalGlobals.window;
    globalThis.fetch = originalGlobals.fetch;
    globalThis.requestAnimationFrame = originalGlobals.requestAnimationFrame;
    globalThis.setInterval = originalGlobals.setInterval;
    globalThis.setTimeout = originalGlobals.setTimeout;
  });

  await import(`../dashboard-agents.js?test=${nextImportTag()}`);
  assert.equal(
    await waitForCondition(() => document.getElementById("agentsExperience").innerHTML.includes("Joinable")),
    true,
    document.getElementById("agentsExperience").innerHTML.slice(0, 1200),
  );

  const toolbar = document.getElementById("pageChrome").querySelector(".subpage-toolbar");
  const toolbarActions = toolbar.children.find((child) => child.className === "agent-toolbar-actions");
  assert.match(toolbarActions?.innerHTML || "", /<span class="agent-toolbar-count">1<\/span>/u);
  const html = document.getElementById("agentsExperience").innerHTML;
  assert.match(html, /JOINABLE[\s\S]*?1/u);
  assert.doesNotMatch(html, /operator/u);
  assert.doesNotMatch(html, /automation/u);
});

test("agents guidance preview keeps latest selection when reads resolve out of order", async (t) => {
  const document = new MockDocument();
  for (const id of ["agentsExperience", "pageChrome", "navBar", "headerTime", "headerDate"]) {
    document.getElementById(id);
  }

  const pendingReads = new Map();
  globalThis.document = document;
  globalThis.window = {
    location: { pathname: "/watchdog/agents-view", search: "", reload() {} },
    setInterval() {
      return 1;
    },
  };
  globalThis.requestAnimationFrame = (callback) => {
    if (typeof callback === "function") callback();
    return 1;
  };
  globalThis.setInterval = () => 1;
  globalThis.setTimeout = () => 1;
  globalThis.fetch = async (url) => {
    const path = String(url);
    if (path.startsWith("/watchdog/agents/discovery")) {
      return {
        ok: true,
        async text() {
          return JSON.stringify({
            agents: [{
              id: "worker",
              role: "executor",
              status: "managed",
              source: "configured",
              guidance: { managed: 2 },
              guidanceFiles: [
                { name: "SOUL.md", state: "managed" },
                { name: "HEARTBEAT.md", state: "managed" },
              ],
            }],
            candidates: [],
            candidateCounts: {},
            localWorkspaceResidue: [],
            localWorkspaceResidueCounts: {},
            counts: { configured: 1, managed: 1 },
          });
        },
      };
    }
    if (path.startsWith("/watchdog/agents/guidance/read")) {
      const parsed = new URL(`http://local${path}`);
      const fileName = parsed.searchParams.get("file");
      return new Promise((resolve) => {
        pendingReads.set(fileName, (content) => resolve({
          ok: true,
          async text() {
            return JSON.stringify({
              agentId: "worker",
              fileName,
              exists: true,
              guidanceState: "managed",
              workspacePath: `/tmp/${fileName}`,
              content,
            });
          },
        }));
      });
    }
    if (path.startsWith("/watchdog/agents")) {
      return {
        ok: true,
        async text() {
          return JSON.stringify([]);
        },
      };
    }
    return {
      ok: false,
      async text() {
        return "";
      },
    };
  };

  t.after(() => {
    globalThis.document = originalGlobals.document;
    globalThis.window = originalGlobals.window;
    globalThis.fetch = originalGlobals.fetch;
    globalThis.requestAnimationFrame = originalGlobals.requestAnimationFrame;
    globalThis.setInterval = originalGlobals.setInterval;
    globalThis.setTimeout = originalGlobals.setTimeout;
  });

  await import(`../dashboard-agents.js?test=${nextImportTag()}`);
  assert.equal(
    await waitForCondition(() => document.getElementById("agentsExperience").innerHTML.includes("data-agent-detail")),
    true,
    document.getElementById("agentsExperience").innerHTML.slice(0, 1200),
  );

  const host = document.getElementById("agentsExperience");
  host.querySelectorAll("[data-agent-detail]")[0]?.click();
  assert.equal(await waitForCondition(() => host.innerHTML.includes("data-agent-preview")), true);
  const [soulButton, heartbeatButton] = host.querySelectorAll("[data-agent-preview]");
  assert.ok(soulButton);
  assert.ok(heartbeatButton);
  soulButton.click();
  heartbeatButton.click();
  await new Promise((resolve) => setImmediate(resolve));

  pendingReads.get("HEARTBEAT.md")?.("latest heartbeat content");
  await new Promise((resolve) => setImmediate(resolve));
  pendingReads.get("SOUL.md")?.("stale soul content");
  await new Promise((resolve) => setImmediate(resolve));

  const html = host.innerHTML;
  assert.match(html, /HEARTBEAT\.md/u);
  assert.match(html, /latest heartbeat content/u);
  assert.doesNotMatch(html, /stale soul content/u);
});
