// lib/task-history-store.js — Encapsulated access to taskHistory[]

import { taskHistory } from "../state-collections.js";
import { MAX_HISTORY } from "../state-constants.js";

export function recordTaskHistory(entry) {
  taskHistory.push({ ...entry, endMs: Date.now() });
  if (taskHistory.length > MAX_HISTORY) taskHistory.shift();
}

export function clearTaskHistory() {
  taskHistory.length = 0;
}

export function getRecentTaskHistory(limit = 10) {
  return taskHistory.slice(-limit);
}

export function getTaskHistoryCount() {
  return taskHistory.length;
}

export function getTaskHistorySnapshot() {
  return taskHistory;
}
