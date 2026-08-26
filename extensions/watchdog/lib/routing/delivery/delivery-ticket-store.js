// delivery-ticket-store.js — 投递票据库(备忘录141 §八 Phase 3 投递出栈)。
//
// 单文件一票:control-plane/delivery-tickets/{id}.json。票据 id 确定性
// dlv-{contractId}(文件名安全化),同 id 重写 = 覆盖——同合约重复 commit 不重票。
//
// 自包含铁律:泵在收尾拆除之后运行,tracker 已删——票据只携带可序列化投影
// (contractId/terminalStatus/outcome/executionObservation/最小 tracker 投影),
// 泵一律从正本(contract store)重读盘上事实。写入前做 JSON 往返校验,
// 不可序列化字段剥离并 warn(投影剥离遵循 JSON.stringify 语义:对象键丢弃、
// 数组位补 null,『键存在但为 null』与『键不存在』的区别保真——replyTo
// hasOwnProperty 语义依赖这一点)。
//
// 生命周期:writeDeliveryTicket(commit 后落票) → listPendingDeliveryTickets
// (泵扫描,坏票跳过不拖垮整扫) → completeDeliveryTicket(投递完成删票) /
// markDeliveryTicketAttempt(失败记账,打满 MAX_DELIVERY_TICKET_ATTEMPTS 次
// 改名 .failed.json 留尸检)。
//
// 默认目录在【首次 IO】时经 resolveDefaultTicketDir 惰性解析 + 环境种子
// OPENCLAW_DELIVERY_TICKET_DIR(照抄 delivery-idempotency-store 手法:
// mock.module 对静态可达消费者无效,环境种子是对静态图也生效的唯一注入面)。

import { mkdir, readFile, readdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";

import { atomicWriteFile, withLock } from "../../state.js";
import { CONTROL_PLANE_PATHS, resolveOwnedStorePath } from "../../control-plane/control-plane-paths.js";

export const MAX_DELIVERY_TICKET_ATTEMPTS = 3;

const FAILED_SUFFIX = ".failed.json";

// ---- 纯逻辑:id/路径 ----

// 确定性票据 id:dlv-{contractId},文件名安全化(charset 白名单,越界字符折 "-")。
// 非串/空白 → null(调用方 bug,writeDeliveryTicket 会抛)。
export function buildDeliveryTicketId(contractId) {
  const trimmed = typeof contractId === "string" ? contractId.trim() : "";
  if (!trimmed) {
    return null;
  }
  const safe = trimmed.replace(/[^A-Za-z0-9._-]/g, "-");
  return `dlv-${safe}`;
}

// 票据 id 只认文件名安全 charset——目录固定 + 白名单即免路径穿越。
function normalizeTicketId(id) {
  const trimmed = typeof id === "string" ? id.trim() : "";
  return trimmed && /^[A-Za-z0-9._-]+$/.test(trimmed) ? trimmed : null;
}

export function resolveDefaultTicketDir() {
  // 店根门卫单源(control-plane-paths §13)。
  return resolveOwnedStorePath("OPENCLAW_DELIVERY_TICKET_DIR", CONTROL_PLANE_PATHS.deliveryTicketsDir, "delivery-tickets");
}

function ticketPaths(ticketId) {
  const dir = resolveDefaultTicketDir();
  return {
    dir,
    activePath: join(dir, `${ticketId}.json`),
    failedPath: join(dir, `${ticketId}${FAILED_SUFFIX}`),
  };
}

// ---- 纯逻辑:可序列化投影(JSON 往返校验的前置剥离) ----

const STRIP = Symbol("delivery-ticket-strip");

function projectSerializable(value, path, strippedPaths, seen) {
  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      if (!Number.isFinite(value)) {
        strippedPaths.push(path || "(root)");
        return STRIP;
      }
      return value;
    case "object": {
      if (value === null) {
        return null;
      }
      if (seen.has(value)) {
        strippedPaths.push(`${path || "(root)"}(circular)`);
        return STRIP;
      }
      if (typeof value.toJSON === "function") {
        // Date 等:与 JSON.stringify 的 toJSON 语义一致
        try {
          return projectSerializable(value.toJSON(), path, strippedPaths, seen);
        } catch {
          strippedPaths.push(path || "(root)");
          return STRIP;
        }
      }
      seen.add(value);
      let projected;
      if (Array.isArray(value)) {
        projected = value.map((item, index) => {
          const itemProjection = projectSerializable(item, `${path}[${index}]`, strippedPaths, seen);
          // JSON.stringify 语义:数组内不可序列化 → null 占位,保住下标对齐
          return itemProjection === STRIP ? null : itemProjection;
        });
      } else {
        projected = {};
        for (const [key, entryValue] of Object.entries(value)) {
          const entryProjection = projectSerializable(
            entryValue,
            path ? `${path}.${key}` : key,
            strippedPaths,
            seen,
          );
          if (entryProjection !== STRIP) {
            projected[key] = entryProjection;
          }
        }
      }
      seen.delete(value); // 只拒真环,共享子对象(DAG)合法
      return projected;
    }
    default:
      // function / symbol / bigint / undefined
      strippedPaths.push(path || "(root)");
      return STRIP;
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function serializeTicket(ticket) {
  return JSON.stringify(ticket, null, 2);
}

// ---- 写票(commit 后落盘;同 id 覆盖) ----

export async function writeDeliveryTicket(ticket) {
  if (!isPlainObject(ticket)) {
    throw new Error("[delivery-ticket] 票据必须是对象");
  }
  const id = buildDeliveryTicketId(ticket.contractId);
  if (!id) {
    throw new Error("[delivery-ticket] 票据缺 contractId,无法生成确定性 id");
  }

  const strippedPaths = [];
  const projected = projectSerializable(ticket, "", strippedPaths, new WeakSet());
  if (strippedPaths.length) {
    console.warn(`[delivery-ticket] 票据 ${id} 剥离不可序列化字段: ${strippedPaths.join(", ")}`);
  }

  const suppressSource = isPlainObject(projected.suppress) ? projected.suppress : {};
  const persisted = {
    ...projected,
    id,
    contractId: ticket.contractId.trim(),
    suppress: {
      deferred: suppressSource.deferred === true,
      deferredBy: (typeof suppressSource.deferredBy === "string" && suppressSource.deferredBy)
        ? suppressSource.deferredBy
        : null,
    },
    trackerProjection: isPlainObject(projected.trackerProjection) ? projected.trackerProjection : {},
    createdAt: Number.isFinite(projected.createdAt) ? projected.createdAt : Date.now(),
    attempts: (Number.isInteger(projected.attempts) && projected.attempts >= 0)
      ? projected.attempts
      : 0,
  };

  // JSON 往返校验:投影后必须无损往返,失败即抛(剥离逻辑或调用方 bug,落坏票更糟)
  const serialized = serializeTicket(persisted);
  if (serializeTicket(JSON.parse(serialized)) !== serialized) {
    throw new Error(`[delivery-ticket] 票据 ${id} JSON 往返校验失败`);
  }

  const { dir, activePath } = ticketPaths(id);
  await withLock(`delivery-ticket:${activePath}`, async () => {
    await mkdir(dir, { recursive: true });
    await atomicWriteFile(activePath, serialized);
  });
  return persisted;
}

// ---- 扫描(泵消费;坏票 warn 跳过,不拖垮整扫) ----

export async function listPendingDeliveryTickets() {
  const dir = resolveDefaultTicketDir();
  let names;
  try {
    names = await readdir(dir);
  } catch {
    return []; // 无目录 = 空账
  }

  const tickets = [];
  for (const name of names) {
    if (!name.endsWith(".json") || name.endsWith(FAILED_SUFFIX)) {
      continue;
    }
    const filePath = join(dir, name);
    try {
      const parsed = JSON.parse(await readFile(filePath, "utf8"));
      if (isPlainObject(parsed)
        && typeof parsed.id === "string" && parsed.id
        && typeof parsed.contractId === "string" && parsed.contractId) {
        tickets.push(parsed);
      } else {
        console.warn(`[delivery-ticket] 坏票跳过(缺 id/contractId): ${filePath}`);
      }
    } catch (error) {
      console.warn(`[delivery-ticket] 坏票跳过(读取/解析失败): ${filePath}: ${error?.message || error}`);
    }
  }
  tickets.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)); // 旧票先泵
  return tickets;
}

// ---- 完成(投递成功删票) ----

export async function completeDeliveryTicket(id) {
  const ticketId = normalizeTicketId(id);
  if (!ticketId) {
    return false;
  }
  const { activePath } = ticketPaths(ticketId);
  try {
    await withLock(`delivery-ticket:${activePath}`, () => unlink(activePath));
    return true;
  } catch (error) {
    if (error?.code !== "ENOENT") {
      console.warn(`[delivery-ticket] 删票失败(${activePath}): ${error?.message || error}`);
    }
    return false;
  }
}

// ---- 失败记账(attempts+1 落盘;打满改名 .failed.json 留尸检) ----

export async function markDeliveryTicketAttempt(id, error = null) {
  const ticketId = normalizeTicketId(id);
  if (!ticketId) {
    return { exhausted: false, attempts: 0, missing: true };
  }
  const { activePath, failedPath } = ticketPaths(ticketId);

  return withLock(`delivery-ticket:${activePath}`, async () => {
    let raw;
    try {
      raw = await readFile(activePath, "utf8");
    } catch {
      return { exhausted: false, attempts: 0, missing: true };
    }

    let ticket = null;
    try {
      const parsed = JSON.parse(raw);
      if (isPlainObject(parsed)) {
        ticket = parsed;
      }
    } catch {}
    if (!ticket) {
      // 坏票续不了 attempts:直接改名留尸检,免得泵在坏票上死循环
      console.warn(`[delivery-ticket] 坏票改名留尸检: ${activePath} → ${failedPath}`);
      await rename(activePath, failedPath);
      return { exhausted: true, attempts: 0, corrupt: true };
    }

    const attempts = ((Number.isInteger(ticket.attempts) && ticket.attempts >= 0) ? ticket.attempts : 0) + 1;
    ticket.attempts = attempts;
    ticket.lastAttemptAt = Date.now();
    ticket.lastError = error == null ? null : String(error?.message || error);
    const serialized = serializeTicket(ticket);

    if (attempts >= MAX_DELIVERY_TICKET_ATTEMPTS) {
      await atomicWriteFile(activePath, serialized);
      await rename(activePath, failedPath);
      console.warn(`[delivery-ticket] 票据 ${ticketId} 重试打满(${attempts}次),改名留尸检: ${failedPath}`);
      return { exhausted: true, attempts };
    }

    await atomicWriteFile(activePath, serialized);
    return { exhausted: false, attempts };
  });
}
