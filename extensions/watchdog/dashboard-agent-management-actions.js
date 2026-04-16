export const AGENT_REMOVAL_MODE = Object.freeze({
  DELETE: "delete",
  HARD_DELETE: "hard_delete",
});

export function resolveAgentRemovalAction(mode, agentId = "") {
  const normalizedMode = mode === AGENT_REMOVAL_MODE.HARD_DELETE
    ? AGENT_REMOVAL_MODE.HARD_DELETE
    : AGENT_REMOVAL_MODE.DELETE;

  if (normalizedMode === AGENT_REMOVAL_MODE.HARD_DELETE) {
    return {
      mode: normalizedMode,
      path: "/watchdog/agents/hard-delete",
      eventType: "agent_hard_deleted",
      successToast: `已彻底删除: ${agentId}`,
      busyLabel: "DELETING...",
    };
  }

  return {
    mode: normalizedMode,
    path: "/watchdog/agents/delete",
    eventType: "agent_deleted",
    successToast: `已从系统移除: ${agentId}`,
    busyLabel: "REMOVING...",
  };
}

export function buildAgentDeleteConfirmation(agentId, mode = AGENT_REMOVAL_MODE.DELETE) {
  if (mode === AGENT_REMOVAL_MODE.HARD_DELETE) {
    return [
      `确认彻底删除 ${agentId}？`,
      "",
      "本地 workspace 会被删除。",
      "agent-card.json、SOUL.md、HEARTBEAT.md、managed guidance、inbox、outbox、output 会一起移除。",
      "此操作不可恢复。",
    ].join("\n");
  }

  return [
    `确认从系统中移除 ${agentId}？`,
    "",
    "此操作只从系统注册中移除。",
    "不删除本地 workspace、引导文件和画像卡。",
  ].join("\n");
}
