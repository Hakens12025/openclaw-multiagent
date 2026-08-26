import { normalizeString } from "../core/normalize.js";

export function normalizeQQIngressSource(source) {
  const normalized = normalizeString(source)?.toLowerCase() || "";
  return normalized === "qqbot" ? "qq" : normalized;
}

export function isQQIngressSource(source) {
  return normalizeQQIngressSource(source) === "qq";
}

export function isSyntheticQQTarget(target) {
  const normalized = normalizeString(target)?.toLowerCase() || "";
  return normalized === "synthetic-test" || normalized === "c2c:synthetic-test";
}

export function assertLiveQQReplyTarget(replyTo) {
  if (replyTo?.channel !== "qqbot") return;
  if (!normalizeString(replyTo.target)) {
    throw new Error("live QQ reply target is required");
  }
  if (isSyntheticQQTarget(replyTo.target)) {
    throw new Error("synthetic QQ reply target is not valid for live QQ delivery");
  }
}

export function assertLiveQQIngressReplyTarget(source, replyTo) {
  if (!isQQIngressSource(source)) return;
  if (replyTo?.channel !== "qqbot" || !normalizeString(replyTo.target)) {
    throw new Error("live QQ reply target is required");
  }
  assertLiveQQReplyTarget(replyTo);
}
