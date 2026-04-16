import { broadcast } from "../transport/sse.js";
import { EVENT_TYPE } from "../core/event-types.js";
import { qqNotify } from "../qq.js";
import { normalizeRecord, normalizeString } from "../core/normalize.js";

const DEFAULT_DELIVERY_MODE = "proactive";
const DELIVERY_TARGET_ADAPTERS = new Map();

function buildDeliveryTargetKey(target) {
  const channel = normalizeString(target?.channel)?.toLowerCase();
  const address = normalizeString(target?.target);
  const mode = normalizeString(target?.mode)?.toLowerCase() || DEFAULT_DELIVERY_MODE;
  if (!channel || !address) return null;
  return `${channel}::${address}::${mode}`;
}

function normalizeDeliveryMode(value) {
  return normalizeString(value)?.toLowerCase() || DEFAULT_DELIVERY_MODE;
}

function normalizeDeliveryTarget(value) {
  const source = normalizeRecord(value, null);
  if (!source) return null;

  const channel = normalizeString(source.channel)?.toLowerCase();
  const target = normalizeString(source.target);
  if (!channel || !target) return null;

  return {
    channel,
    target,
    mode: normalizeDeliveryMode(source.mode),
    label: normalizeString(source.label) || null,
  };
}

export function normalizeDeliveryTargets(values) {
  const list = Array.isArray(values) ? values : [values];
  const targets = [];
  const seen = new Set();

  for (const item of list) {
    const normalized = normalizeDeliveryTarget(item);
    if (!normalized) continue;
    const key = buildDeliveryTargetKey(normalized);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    targets.push(normalized);
  }

  return targets;
}

export function listContractDeliveryTargets(contract) {
  return normalizeDeliveryTargets(contract?.deliveryTargets || []);
}

function isSameDeliveryTarget(left, right) {
  const leftKey = buildDeliveryTargetKey(left);
  const rightKey = buildDeliveryTargetKey(right);
  return Boolean(leftKey && rightKey && leftKey === rightKey);
}

export function excludeDeliveryTargets(targets, excludedTargets = []) {
  const normalizedExcluded = normalizeDeliveryTargets(excludedTargets);
  if (normalizedExcluded.length === 0) return normalizeDeliveryTargets(targets);
  return normalizeDeliveryTargets(targets).filter((target) =>
    !normalizedExcluded.some((excluded) => isSameDeliveryTarget(target, excluded)));
}

function registerDeliveryTargetAdapter(channel, handler) {
  const normalizedChannel = normalizeString(channel)?.toLowerCase();
  if (!normalizedChannel || typeof handler !== "function") {
    throw new TypeError("registerDeliveryTargetAdapter requires channel and handler");
  }
  DELIVERY_TARGET_ADAPTERS.set(normalizedChannel, handler);
}

async function deliverDeliveryTargetMessage(target, message, {
  contractId = null,
  logger = null,
} = {}) {
  const normalizedTarget = normalizeDeliveryTarget(target);
  const text = String(message || "").trim();

  if (!normalizedTarget) {
    return {
      ok: false,
      channel: null,
      target: null,
      mode: DEFAULT_DELIVERY_MODE,
      error: "invalid_delivery_target",
      notified: false,
    };
  }
  if (!text) {
    return {
      ok: false,
      channel: normalizedTarget.channel,
      target: normalizedTarget.target,
      mode: normalizedTarget.mode,
      error: "empty_delivery_message",
      notified: false,
    };
  }

  const adapter = DELIVERY_TARGET_ADAPTERS.get(normalizedTarget.channel);
  if (!adapter) {
    logger?.warn?.(`[delivery-target] unsupported channel: ${normalizedTarget.channel}`);
    const result = {
      ok: false,
      channel: normalizedTarget.channel,
      target: normalizedTarget.target,
      mode: normalizedTarget.mode,
      error: "unsupported_delivery_channel",
      notified: false,
    };
    broadcast("alert", {
      type: EVENT_TYPE.DELIVERY_TARGET_NOTIFY,
      contractId,
      ...result,
      ts: Date.now(),
    });
    return result;
  }

  try {
    const adapterResult = await adapter({
      target: normalizedTarget,
      message: text,
      contractId,
      logger,
    });
    const result = {
      ok: adapterResult?.ok === true,
      channel: normalizedTarget.channel,
      target: normalizedTarget.target,
      mode: normalizedTarget.mode,
      notified: adapterResult?.ok === true,
      error: adapterResult?.ok === true
        ? null
        : adapterResult?.error || adapterResult?.detail || adapterResult?.reason || "delivery_target_failed",
      detail: adapterResult?.detail || null,
      reason: adapterResult?.reason || null,
      code: adapterResult?.code || null,
      errCode: adapterResult?.errCode || null,
      traceId: adapterResult?.traceId || null,
      chunkCount: adapterResult?.chunkCount || 1,
    };
    broadcast("alert", {
      type: EVENT_TYPE.DELIVERY_TARGET_NOTIFY,
      contractId,
      ...result,
      ts: Date.now(),
    });
    return result;
  } catch (error) {
    const result = {
      ok: false,
      channel: normalizedTarget.channel,
      target: normalizedTarget.target,
      mode: normalizedTarget.mode,
      notified: false,
      error: error instanceof Error ? error.message : String(error || "delivery_target_failed"),
    };
    broadcast("alert", {
      type: EVENT_TYPE.DELIVERY_TARGET_NOTIFY,
      contractId,
      ...result,
      ts: Date.now(),
    });
    return result;
  }
}

export async function deliverDeliveryTargets(targets, message, context = {}) {
  const normalizedTargets = normalizeDeliveryTargets(targets);
  const results = [];
  for (const target of normalizedTargets) {
    results.push(await deliverDeliveryTargetMessage(target, message, context));
  }
  return results;
}

registerDeliveryTargetAdapter("qqbot", async ({
  target,
  message,
}) => {
  const notify = await qqNotify(target.target, message);
  return {
    ...notify,
    ok: notify?.ok === true,
  };
});
