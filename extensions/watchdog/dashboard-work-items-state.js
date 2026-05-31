function normalizeText(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeOptionalValue(value) {
  const normalized = String(value || "").trim();
  return normalized || null;
}

function toSearchParams(search) {
  if (search instanceof URLSearchParams) {
    return new URLSearchParams(search.toString());
  }
  return new URLSearchParams(String(search || ""));
}

function isActiveStatus(status) {
  return ["pending", "running", "awaiting_input"].includes(normalizeText(status));
}

export function normalizeWorkItemFilters(filters = {}) {
  return {
    status: filters.status || "all",
    assignee: filters.assignee || "all",
    query: String(filters.query || "").trim(),
  };
}

export function parseWorkItemViewState(search = "") {
  const params = toSearchParams(search);
  return {
    filters: normalizeWorkItemFilters({
      status: params.get("status") || "all",
      assignee: params.get("assignee") || "all",
      query: params.get("query") || "",
    }),
    selectedId: normalizeOptionalValue(params.get("selected")),
    backHref: normalizeOptionalValue(params.get("back")),
  };
}

export function buildWorkItemViewSearch(search = "", { filters, selectedId, backHref } = {}) {
  const params = toSearchParams(search);
  const nextFilters = normalizeWorkItemFilters(filters);

  if (nextFilters.status === "all") params.delete("status");
  else params.set("status", nextFilters.status);

  if (nextFilters.assignee === "all") params.delete("assignee");
  else params.set("assignee", nextFilters.assignee);

  if (!nextFilters.query) params.delete("query");
  else params.set("query", nextFilters.query);

  const normalizedSelectedId = normalizeOptionalValue(selectedId);
  if (normalizedSelectedId) params.set("selected", normalizedSelectedId);
  else params.delete("selected");

  const normalizedBackHref = normalizeOptionalValue(backHref);
  if (normalizedBackHref) params.set("back", normalizedBackHref);
  else if (backHref === null) params.delete("back");

  return params.toString();
}

export function buildWorkItemsViewHref(search = "", { filters, selectedId, backHref } = {}) {
  const nextSearch = buildWorkItemViewSearch(search, { filters, selectedId, backHref });
  return `/watchdog/work-items-view${nextSearch ? `?${nextSearch}` : ""}`;
}

export function filterAndSortWorkItems(items, rawFilters = {}) {
  const filters = normalizeWorkItemFilters(rawFilters);
  const query = normalizeText(filters.query);
  return (Array.isArray(items) ? items : [])
    .filter((item) => {
      if (filters.status !== "all" && item?.status !== filters.status) {
        return false;
      }
      if (filters.assignee !== "all" && item?.assignee !== filters.assignee) {
        return false;
      }
      if (!query) {
        return true;
      }
      const haystack = [
        item?.id,
        item?.task,
        item?.assignee,
        item?.replyTargetAgent,
        item?.taskType,
      ].map(normalizeText).join(" ");
      return haystack.includes(query);
    })
    .sort((left, right) => (
      (Number(right?.updatedAt) || Number(right?.createdAt) || 0)
      - (Number(left?.updatedAt) || Number(left?.createdAt) || 0)
    ));
}

export function resolveSelectedWorkItemId(items, currentId = null) {
  const visible = Array.isArray(items) ? items : [];
  if (currentId && visible.some((item) => item?.id === currentId)) {
    return currentId;
  }
  return visible[0]?.id || null;
}

export function buildWorkItemSummary(items) {
  const list = Array.isArray(items) ? items : [];
  return {
    total: list.length,
    active: list.filter((item) => isActiveStatus(item?.status)).length,
    completed: list.filter((item) => item?.status === "completed").length,
    failed: list.filter((item) => item?.status === "failed").length,
    awaitingInput: list.filter((item) => item?.status === "awaiting_input").length,
  };
}
