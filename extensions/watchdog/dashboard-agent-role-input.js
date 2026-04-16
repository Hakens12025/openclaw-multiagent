export const DEFAULT_AGENT_ROLE = "agent";

export const ROLE_SUGGESTIONS = Object.freeze([
  "agent",
  "bridge",
  "planner",
  "executor",
  "researcher",
  "reviewer",
]);

export function normalizeAgentRoleDraft(value, fallback = DEFAULT_AGENT_ROLE) {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized === "--") return fallback;
  return ROLE_SUGGESTIONS.includes(normalized) ? normalized : fallback;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function renderAgentRoleInput({
  agentId,
  value = DEFAULT_AGENT_ROLE,
  compact = false,
} = {}) {
  const datalistId = `agent-role-suggestions-${String(agentId || "unknown")}${compact ? "-compact" : ""}`;
  const normalizedValue = normalizeAgentRoleDraft(value);
  return `
    <label class="agents-role-picker${compact ? " compact" : ""}">
      <span>ROLE</span>
      <input
        type="text"
        value="${escapeHtml(normalizedValue)}"
        list="${escapeHtml(datalistId)}"
        data-agent-role="${escapeHtml(agentId || "")}"
        placeholder="${DEFAULT_AGENT_ROLE}"
        spellcheck="false"
        autocomplete="off"
      >
      <datalist id="${escapeHtml(datalistId)}">
        ${ROLE_SUGGESTIONS.map((role) => `<option value="${escapeHtml(role)}"></option>`).join("")}
      </datalist>
    </label>
  `;
}
