import test from "node:test";
import assert from "node:assert/strict";

import {
  buildWorkItemsViewHref,
  buildWorkItemViewSearch,
  buildWorkItemSummary,
  filterAndSortWorkItems,
  normalizeWorkItemFilters,
  parseWorkItemViewState,
  resolveSelectedWorkItemId,
} from "../dashboard-work-items-state.js";

const ITEMS = [
  {
    id: "TC-3",
    task: "优化图路由",
    assignee: "worker",
    status: "running",
    updatedAt: 30,
    createdAt: 10,
  },
  {
    id: "TC-2",
    task: "写塑形说明",
    assignee: "planner",
    status: "completed",
    updatedAt: 20,
    createdAt: 5,
  },
  {
    id: "TC-1",
    task: "图回路恢复",
    assignee: "worker",
    status: "failed",
    updatedAt: 10,
    createdAt: 1,
  },
];

test("normalizeWorkItemFilters applies stable defaults", () => {
  assert.deepEqual(normalizeWorkItemFilters({}), {
    status: "all",
    assignee: "all",
    query: "",
  });
});

test("filterAndSortWorkItems filters by status and assignee", () => {
  const result = filterAndSortWorkItems(ITEMS, {
    status: "failed",
    assignee: "worker",
    query: "",
  });
  assert.deepEqual(result.map((item) => item.id), ["TC-1"]);
});

test("filterAndSortWorkItems searches across id task and assignee", () => {
  const result = filterAndSortWorkItems(ITEMS, {
    status: "all",
    assignee: "all",
    query: "planner",
  });
  assert.deepEqual(result.map((item) => item.id), ["TC-2"]);
});

test("resolveSelectedWorkItemId prefers current item when still visible", () => {
  assert.equal(resolveSelectedWorkItemId(ITEMS, "TC-2"), "TC-2");
});

test("resolveSelectedWorkItemId falls back to newest visible item", () => {
  assert.equal(resolveSelectedWorkItemId(ITEMS, "MISSING"), "TC-3");
});

test("buildWorkItemSummary counts total active completed and failed", () => {
  assert.deepEqual(buildWorkItemSummary(ITEMS), {
    total: 3,
    active: 1,
    completed: 1,
    failed: 1,
    awaitingInput: 0,
  });
});

test("parseWorkItemViewState hydrates filters and selected id from url params", () => {
  assert.deepEqual(
    parseWorkItemViewState("?token=abc&status=failed&assignee=worker&query=graph&selected=TC-9&back=%2Fwatchdog%2Fprogress%3Ftoken%3Dabc"),
    {
      filters: {
        status: "failed",
        assignee: "worker",
        query: "graph",
      },
      selectedId: "TC-9",
      backHref: "/watchdog/progress?token=abc",
    },
  );
});

test("buildWorkItemViewSearch preserves foreign params and omits default filters", () => {
  const next = new URLSearchParams(buildWorkItemViewSearch("?token=abc&foo=bar", {
    filters: {
      status: "all",
      assignee: "all",
      query: "",
    },
    selectedId: null,
  }));

  assert.equal(next.get("token"), "abc");
  assert.equal(next.get("foo"), "bar");
  assert.equal(next.has("status"), false);
  assert.equal(next.has("assignee"), false);
  assert.equal(next.has("query"), false);
  assert.equal(next.has("selected"), false);
});

test("buildWorkItemViewSearch writes non-default filters and selected id", () => {
  const next = new URLSearchParams(buildWorkItemViewSearch("?token=abc", {
    filters: {
      status: "failed",
      assignee: "worker",
      query: "graph",
    },
    selectedId: "TC-9",
  }));

  assert.equal(next.get("token"), "abc");
  assert.equal(next.get("status"), "failed");
  assert.equal(next.get("assignee"), "worker");
  assert.equal(next.get("query"), "graph");
  assert.equal(next.get("selected"), "TC-9");
});

test("buildWorkItemsViewHref targets work-items-view and carries selected state", () => {
  assert.equal(
    buildWorkItemsViewHref("?token=abc", {
      selectedId: "TC-9",
      backHref: "/watchdog/progress?token=abc&page=home",
    }),
    "/watchdog/work-items-view?token=abc&selected=TC-9&back=%2Fwatchdog%2Fprogress%3Ftoken%3Dabc%26page%3Dhome",
  );
});
