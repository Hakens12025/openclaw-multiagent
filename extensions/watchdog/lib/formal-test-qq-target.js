import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_QQ_AGENT_ID = "agent-for-kksl";
const DEFAULT_ACCOUNT_ID = "default";
const KNOWN_USERS_FILE = join(homedir(), "clawd", "qqbot-data", "known-users.json");

function normalizeString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeTargetAddress(value) {
  const raw = normalizeString(value);
  if (!raw) return null;
  if (raw.startsWith("c2c:") || raw.startsWith("group:") || raw.startsWith("channel:")) {
    return raw;
  }
  return `c2c:${raw}`;
}

function knownUserAddress(user) {
  if (!user || typeof user !== "object") return null;
  if (user.type === "c2c") {
    return normalizeTargetAddress(user.openid);
  }
  if (user.type === "group") {
    const groupOpenid = normalizeString(user.groupOpenid);
    return groupOpenid ? `group:${groupOpenid}` : null;
  }
  return null;
}

export function resolveQQTestTarget({
  env = process.env,
  knownUsers = [],
} = {}) {
  const explicitTarget = normalizeTargetAddress(env.OPENCLAW_TEST_QQ_TARGET || env.QQ_TEST_TARGET);
  if (explicitTarget) {
    return {
      channel: "qqbot",
      target: explicitTarget,
      accountId: normalizeString(env.OPENCLAW_TEST_QQ_ACCOUNT_ID || env.QQ_TEST_ACCOUNT_ID) || DEFAULT_ACCOUNT_ID,
    };
  }

  const candidate = [...(Array.isArray(knownUsers) ? knownUsers : [])]
    .filter((user) => user?.type === "c2c" && knownUserAddress(user))
    .sort((a, b) => Number(b.lastSeenAt || 0) - Number(a.lastSeenAt || 0))[0];
  const target = knownUserAddress(candidate);
  if (!target) {
    throw new Error("missing QQ test target; set OPENCLAW_TEST_QQ_TARGET or send one live QQ message first");
  }
  return {
    channel: "qqbot",
    target,
    accountId: normalizeString(candidate.accountId) || DEFAULT_ACCOUNT_ID,
  };
}

export async function loadQQTestTarget({ env = process.env } = {}) {
  let knownUsers = [];
  try {
    knownUsers = JSON.parse(await readFile(KNOWN_USERS_FILE, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return resolveQQTestTarget({ env, knownUsers });
}

export function buildQQTestReplyTo({
  runId,
  target,
  agentId = DEFAULT_QQ_AGENT_ID,
} = {}) {
  const normalizedRunId = normalizeString(runId);
  if (!normalizedRunId) {
    throw new TypeError("buildQQTestReplyTo requires runId");
  }
  const address = normalizeTargetAddress(target?.target);
  if (!address) {
    throw new TypeError("buildQQTestReplyTo requires target.target");
  }
  return {
    kind: "test_run",
    runId: normalizedRunId,
    agentId,
    sessionKey: `test-run:${normalizedRunId}`,
    channel: "qqbot",
    target: address,
    accountId: normalizeString(target.accountId) || DEFAULT_ACCOUNT_ID,
  };
}

export async function createQQTestReplyTo(runId, options = {}) {
  const target = options.target || await loadQQTestTarget({ env: options.env || process.env });
  return buildQQTestReplyTo({ runId, target, agentId: options.agentId || DEFAULT_QQ_AGENT_ID });
}
