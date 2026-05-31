import test from "node:test";
import assert from "node:assert/strict";

const previousWindow = globalThis.window;
const previousDocument = globalThis.document;

function createButton(attributeName, value) {
  const listeners = new Map();
  return {
    getAttribute(name) {
      return name === attributeName ? value : null;
    },
    addEventListener(type, handler) {
      listeners.set(type, handler);
    },
    click() {
      listeners.get("click")?.();
    },
  };
}

function createHost() {
  let html = "";
  const cache = new Map();
  return {
    get innerHTML() {
      return html;
    },
    set innerHTML(value) {
      html = String(value || "");
      cache.clear();
    },
    querySelectorAll(selector) {
      if (!cache.has(selector)) {
        const match = selector.match(/^\[([^\]]+)\]$/);
        if (!match) {
          cache.set(selector, []);
        } else {
          const attributeName = match[1];
          const expression = new RegExp(`${attributeName}="([^"]+)"`, "g");
          const buttons = [...html.matchAll(expression)].map((entry) => createButton(attributeName, entry[1]));
          cache.set(selector, buttons);
        }
      }
      return cache.get(selector);
    },
  };
}

globalThis.window = {
  location: {
    pathname: "/watchdog/devtools",
    search: "?token=abc123&tab=change_sets",
  },
  OpenClawDevtoolsModules: {},
};

await import("../dashboard-devtools-change-sets.js");

test("change-set work item action opens the formal work-items detail page with selected/back state", () => {
  const host = createHost();
  globalThis.document = {
    getElementById(id) {
      return id === "testDevtoolSummary" ? host : null;
    },
  };

  const openedPaths = [];
  const app = {
    state: {
      selectedDraftId: "DRAFT-1",
      selectedDraft: {
        id: "DRAFT-1",
        title: "Draft 1",
        surfaceId: "graph.edge.add",
        verificationHistory: [],
        executionHistory: [],
      },
      selectedVerificationId: null,
      selectedExecutionId: null,
      systemActionDeliveryTickets: [],
      changeSets: [],
    },
    esc(value) {
      return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
    },
    normalizeStatusClass(status) {
      return String(status || "draft").toLowerCase();
    },
    formatKnownSurfaceDisplayId(surfaceId, fallback = "--") {
      return surfaceId || fallback;
    },
    formatTimestamp() {
      return "--";
    },
    renderManagementContextCard() {
      return "";
    },
    renderDetailCard() {
      return "";
    },
    getOperatorSnapshot() {
      return null;
    },
    getOperatorSelectedDraftSummary() {
      return {
        recommendedAction: null,
        related: {
          activeWorkItems: [
            {
              id: "TC-9",
              status: "pending",
              assignee: "worker-3",
              taskType: "research",
              task: "inspect runtime graph behavior",
            },
          ],
          failedWorkItems: [],
          activeRuntimeReturns: [],
          recentTestRuns: [],
        },
      };
    },
    getSelectedDraftManagementContext() {
      return null;
    },
    openTokenizedPath(path) {
      openedPaths.push(path);
    },
    openRunInTestRuns() {},
    selectVerification() {},
    selectExecution() {},
    returnToManagementView() {},
    openOperatorRecommendedAction() {},
    selectDraft() {},
    getOperatorWorkQueue() {
      return [];
    },
    getOperatorAttention() {
      return [];
    },
  };

  const createChangeSetView = globalThis.window.OpenClawDevtoolsModules.createChangeSetView;
  const view = createChangeSetView(app);
  view.renderSummary();

  const workItemButtons = host.querySelectorAll("[data-open-work-items-for]");
  assert.equal(workItemButtons.length, 1);

  workItemButtons[0].click();

  assert.deepEqual(openedPaths, [
    "/watchdog/work-items-view?selected=TC-9&back=%2Fwatchdog%2Fdevtools%3Ftoken%3Dabc123%26tab%3Dchange_sets",
  ]);
});

test.after(() => {
  if (previousWindow === undefined) {
    delete globalThis.window;
  } else {
    globalThis.window = previousWindow;
  }

  if (previousDocument === undefined) {
    delete globalThis.document;
  } else {
    globalThis.document = previousDocument;
  }
});
