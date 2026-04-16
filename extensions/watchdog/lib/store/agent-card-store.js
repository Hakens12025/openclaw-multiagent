// lib/agent-card-store.js — Encapsulated access to agentCards Map

import { agentCards } from "../state-collections.js";

export function setAgentCard(agentId, card) {
  agentCards.set(agentId, card);
}

export function deleteAgentCard(agentId) {
  agentCards.delete(agentId);
}

export function getAgentCard(agentId) {
  return agentCards.get(agentId) || null;
}

export function listAgentCards() {
  return [...agentCards.entries()];
}

export function clearAgentCards() {
  agentCards.clear();
}
