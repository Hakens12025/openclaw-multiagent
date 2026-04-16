// lib/conversations.js — Per-conversation state for continuous task context
// Maintains conversation history so that ingress can inject priorContext into contracts.

import { readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { OC, atomicWriteFile, withLock } from "./state.js";

const CONVERSATIONS_DIR = join(OC, "workspaces", "controller", "conversations");
const MAX_RECENT_ROUNDS = 3;

export function buildConversationId(replyTo) {
  if (!replyTo) return null;
  if (replyTo.channel === "qqbot" && replyTo.target) {
    return `qq:${replyTo.target}`;
  }
  return null;
}

export async function loadConversation(conversationId) {
  if (!conversationId) return null;
  try {
    const filePath = join(CONVERSATIONS_DIR, `${sanitizeFilename(conversationId)}.json`);
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function saveConversation(state) {
  if (!state?.conversationId) return;
  await mkdir(CONVERSATIONS_DIR, { recursive: true });
  const filePath = join(CONVERSATIONS_DIR, `${sanitizeFilename(state.conversationId)}.json`);
  await atomicWriteFile(filePath, JSON.stringify(state, null, 2));
}

export async function recordRound(conversationId, { contractId, taskSummary, resultSummary, artifacts, replyTo }) {
  if (!conversationId) return;
  return withLock(`conversation:${conversationId}`, async () => {
    const existing = await loadConversation(conversationId) || {
      conversationId,
      source: conversationId.startsWith("qq:") ? "qq" : "unknown",
      replyTo: replyTo || null,
      recentRounds: [],
      activeContractId: null,
      updatedAt: Date.now(),
    };

    existing.recentRounds.push({
      contractId,
      taskSummary: String(taskSummary || "").slice(0, 200),
      resultSummary: String(resultSummary || "").slice(0, 400),
      artifacts: artifacts || [],
      ts: Date.now(),
    });

    // Keep only the most recent rounds
    if (existing.recentRounds.length > MAX_RECENT_ROUNDS) {
      existing.recentRounds = existing.recentRounds.slice(-MAX_RECENT_ROUNDS);
    }

    existing.activeContractId = null;
    existing.updatedAt = Date.now();
    if (replyTo) existing.replyTo = replyTo;

    await saveConversation(existing);
  });
}

export function buildPriorContext(conversationState) {
  if (!conversationState?.recentRounds?.length) return null;
  return conversationState.recentRounds.map((round) => ({
    contractId: round.contractId,
    summary: round.taskSummary
      ? `${round.taskSummary}${round.resultSummary ? ` → ${round.resultSummary}` : ""}`
      : round.resultSummary || "",
    artifacts: round.artifacts || [],
  }));
}

function sanitizeFilename(id) {
  return String(id).replace(/[^a-zA-Z0-9_:-]/g, "_");
}
