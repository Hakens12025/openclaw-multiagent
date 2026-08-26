// lib/store/agent-card-store.js — agentCards 租约化试点（RX-01 首店）:
// 条目带 owner 元数据,注册返回单次生效的撤销凭证,sweep 依存活谓词清幽灵并记名。
// （5·29 审计「registry 失效/幽灵引用」的对症修法;推广批以本文件为模板。）
import { agentCards } from "../state/state-collections.js";

const cardMeta = new Map(); // agentId → { owner, registeredAt }

export function setAgentCard(agentId, card, owner = "unknown") {
  agentCards.set(agentId, card);
  cardMeta.set(agentId, { owner, registeredAt: Date.now() });
  let disposed = false;
  return function disposeAgentCard() {
    if (disposed) return false;
    disposed = true;
    agentCards.delete(agentId);
    cardMeta.delete(agentId);
    return true;
  };
}

export function deleteAgentCard(agentId) {
  cardMeta.delete(agentId);
  return agentCards.delete(agentId);
}

export function getAgentCard(agentId) {
  return agentCards.get(agentId) || null;
}

export function getAgentCardMeta(agentId) {
  return cardMeta.get(agentId) || null;
}

export function listAgentCards() {
  return [...agentCards.entries()];
}

export function clearAgentCards() {
  agentCards.clear();
  cardMeta.clear();
}

export function sweepAgentCards(isAlive, { logger, graceMs = 60_000, dryRun = false } = {}) {
  const now = Date.now();
  const swept = [];
  for (const agentId of [...agentCards.keys()]) {
    const meta = cardMeta.get(agentId);
    // 在途宽限:admin create 先 setAgentCard(:221)后 saveConfig(:228),新卡不判死;
    // profile 覆写会刷新 registeredAt = 续期宽限,语义可接受。
    if (meta && now - meta.registeredAt < graceMs) continue;
    if (!isAlive(agentId)) {
      swept.push({ agentId, owner: meta?.owner || "unknown" });
      if (!dryRun) {
        agentCards.delete(agentId);
        cardMeta.delete(agentId);
      }
    }
  }
  if (swept.length) {
    logger?.warn?.(`[watchdog] ${dryRun ? "would sweep" : "swept"} ${swept.length} ghost agent card(s): ${swept.map((s) => `${s.agentId}(owner=${s.owner})`).join(", ")}`);
  }
  return swept;
}
