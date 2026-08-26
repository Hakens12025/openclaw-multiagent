// delivery-idempotency-store.js — 投递幂等键账(备忘录141 §三 · 锁B落地)。
//
// 盘上 append-only JSONL + 内存 Set。键形:
//   wake:{targetSessionKey}:{deliveryTicketId||sourceContractId}
//   deliver:{ticketId}
// 纪律(由调用方与本店共同守):
//   - 有身份才去重:deliveryTicketId/sourceContractId 双缺 → 键=null,调用方照发
//     (generic/heartbeat/人工唤醒永不去重,拒发会饿死回投腿的宿主排队机制)
//   - 发送成功才记键:首发失败不记、重试照发——记账时机由调用方把守,本店只提供 has/record
//   - 追加写失败 warn 不抛:内存 Set 仍守住本进程去重,盘上耐久性降级
// 载入时容量治理:>COMPACT_TRIGGER_LINES 行压实到最近 COMPACT_KEEP_LINES 行,原子写回。
// 纯逻辑(键构造/压实判定)零 IO,供 tests/delivery-idempotency-store.test.js 直接锁。

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

import { atomicWriteFile, withLock } from "../state/state-file-utils.js";
import { CONTROL_PLANE_PATHS, resolveOwnedStorePath } from "../control-plane/control-plane-paths.js";

// ---- 纯逻辑:键构造 ----

export const COMPACT_TRIGGER_LINES = 4000;
export const COMPACT_KEEP_LINES = 2000;

function normalizeIdentityPart(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

// 与 tracker-store 的 normalizeSessionKey 同一归一(trim+toLowerCase),
// 否则相位真值与键账对同一会话产出两个键(测绘备注⑥)。
function normalizeSessionKeyPart(sessionKey) {
  return typeof sessionKey === "string" && sessionKey.trim()
    ? sessionKey.trim().toLowerCase()
    : null;
}

// 无身份(两个 id 都缺)→ null:调用方拿到 null 时跳过去重、照发。
// sessionKey 缺失但身份在手仍成键(票据/合约 id 本身全局唯一,足以定住同一次投递)。
export function buildWakeIdempotencyKey({
  targetSessionKey,
  deliveryTicketId,
  sourceContractId,
} = {}) {
  const identityPart = normalizeIdentityPart(deliveryTicketId)
    || normalizeIdentityPart(sourceContractId);
  if (!identityPart) {
    return null;
  }
  return `wake:${normalizeSessionKeyPart(targetSessionKey) || ""}:${identityPart}`;
}

// 票据键必须带腿别:assign 的派发腿与回投腿共用同一 SADT 票据且同一入箱漏斗,
// 无腿别时派发记键会把回投永久去重(2026-08-12 对抗审查抓获的跨腿碰撞,live 复现确认)。
export const DELIVERY_LEGS = Object.freeze({ DISPATCH: "dispatch", RETURN: "return" });

export function buildDeliverIdempotencyKey(ticketId, leg = DELIVERY_LEGS.RETURN) {
  const identityPart = normalizeIdentityPart(ticketId);
  if (!identityPart) {
    return null;
  }
  const legPart = leg === DELIVERY_LEGS.DISPATCH ? DELIVERY_LEGS.DISPATCH : DELIVERY_LEGS.RETURN;
  return `deliver:${legPart}:${identityPart}`;
}

// ---- 纯逻辑:压实判定 ----

// entries 按文件顺序(旧→新)。不需压实 → null;需压实 → 保留的最近 keep 条(仍旧→新)。
export function compactLedgerEntries(entries, {
  trigger = COMPACT_TRIGGER_LINES,
  keep = COMPACT_KEEP_LINES,
} = {}) {
  if (!Array.isArray(entries) || entries.length <= trigger) {
    return null;
  }
  return entries.slice(entries.length - keep);
}

function serializeLedgerEntries(entries) {
  return entries.length
    ? entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n"
    : "";
}

// 防御式逐行解析:进程崩溃可能留下截断尾行,坏行跳过不拖垮整账。
function parseLedgerLines(raw) {
  const entries = [];
  for (const line of String(raw).split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed.key === "string" && parsed.key) {
        entries.push(parsed);
      }
    } catch {}
  }
  return entries;
}

// ---- IO:键账实例(路径可注入,测试勿写真 control-plane) ----

// 默认实例的路径在【首次 IO】时解析:测试进程在模块体里设置环境种子即可把
// 键账指到临时目录——mock.module 对静态可达的消费者无效(ESM 先链接后求值,
// 2026-08-12 实测),环境种子是对静态图也生效的唯一注入面。
export function resolveDefaultLedgerPath() {
  // 店根门卫单源(control-plane-paths §13)。
  return resolveOwnedStorePath("OPENCLAW_DELIVERY_LEDGER_FILE", CONTROL_PLANE_PATHS.deliveryIdempotencyFile, "delivery-idempotency.jsonl");
}

export function createDeliveryIdempotencyStore({
  filePath = null,
  compactTrigger = COMPACT_TRIGGER_LINES,
  compactKeep = COMPACT_KEEP_LINES,
} = {}) {
  const fixedPath = filePath;
  const resolvePath = () => fixedPath || resolveDefaultLedgerPath();
  const keys = new Set();
  let hydrationPromise = null;

  async function hydrate() {
    const filePath = resolvePath();
    const lockKey = `delivery-idempotency:${filePath}`;
    let raw;
    try {
      raw = await readFile(filePath, "utf8");
    } catch {
      return; // 无文件 = 空账
    }
    const entries = parseLedgerLines(raw);
    const compacted = compactLedgerEntries(entries, { trigger: compactTrigger, keep: compactKeep });
    for (const entry of compacted || entries) {
      keys.add(entry.key);
    }
    if (compacted) {
      await withLock(lockKey, async () => {
        await atomicWriteFile(filePath, serializeLedgerEntries(compacted));
      });
    }
  }

  function ensureHydrated() {
    if (!hydrationPromise) {
      hydrationPromise = hydrate().catch((error) => {
        console.warn(`[delivery-idempotency] 载入键账失败(${resolvePath()}),按空账继续: ${error?.message || error}`);
      });
    }
    return hydrationPromise;
  }

  async function hasDeliveryKey(key) {
    const normalizedKey = normalizeIdentityPart(key);
    if (!normalizedKey) {
      return false;
    }
    await ensureHydrated();
    return keys.has(normalizedKey);
  }

  async function recordDeliveryKey(key, meta = null) {
    const normalizedKey = normalizeIdentityPart(key);
    if (!normalizedKey) {
      return false;
    }
    await ensureHydrated();
    if (keys.has(normalizedKey)) {
      return true; // 同键 no-op:不追加重复行
    }
    keys.add(normalizedKey);
    const entry = { key: normalizedKey, at: Date.now() };
    if (meta && typeof meta === "object") {
      entry.meta = meta;
    }
    const filePath = resolvePath();
    try {
      await withLock(`delivery-idempotency:${filePath}`, async () => {
        await mkdir(dirname(filePath), { recursive: true });
        await appendFile(filePath, JSON.stringify(entry) + "\n", "utf8");
      });
    } catch (error) {
      console.warn(`[delivery-idempotency] 追加键账失败(${filePath}): ${error?.message || error}`);
    }
    return true;
  }

  return { hasDeliveryKey, recordDeliveryKey };
}

// ---- 默认实例(唯一真值账本;载入是惰性的,import 本模块不碰盘) ----

const defaultStore = createDeliveryIdempotencyStore();

export const hasDeliveryKey = defaultStore.hasDeliveryKey;
export const recordDeliveryKey = defaultStore.recordDeliveryKey;
