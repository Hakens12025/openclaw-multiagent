import { normalizeString } from "../core/normalize.js";

export function buildAgentMainSessionKey(agentId) {
  const normalizedAgentId = normalizeString(agentId);
  if (!normalizedAgentId) return null;
  return `agent:${normalizedAgentId}:main`;
}

export function buildAgentContractSessionKey(agentId, contractId) {
  const normalizedAgentId = normalizeString(agentId);
  const normalizedContractId = normalizeString(contractId);
  if (!normalizedAgentId || !normalizedContractId) return null;
  return `agent:${normalizedAgentId}:contract:${normalizedContractId}`;
}

export function parseAgentContractSessionKey(sessionKey) {
  const normalizedSessionKey = normalizeString(sessionKey);
  if (!normalizedSessionKey) return null;
  const match = normalizedSessionKey.match(/^agent:([^:]+):contract:(.+)$/i);
  if (!match) return null;

  const agentId = normalizeString(match[1]);
  const contractId = normalizeString(match[2]);
  if (!agentId || !contractId) return null;

  return { agentId, contractId };
}
