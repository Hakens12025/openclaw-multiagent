// lib/heartbeat-session-store.js — Encapsulated access to ignoredHeartbeatSessions Set

import { ignoredHeartbeatSessions } from "../state-collections.js";

export function ignoreHeartbeatSession(sessionKey) {
  ignoredHeartbeatSessions.add(sessionKey);
}

export function unignoreHeartbeatSession(sessionKey) {
  ignoredHeartbeatSessions.delete(sessionKey);
}

export function isHeartbeatSessionIgnored(sessionKey) {
  return ignoredHeartbeatSessions.has(sessionKey);
}

export function clearIgnoredHeartbeatSessions() {
  ignoredHeartbeatSessions.clear();
}

export function getIgnoredHeartbeatSessionCount() {
  return ignoredHeartbeatSessions.size;
}
