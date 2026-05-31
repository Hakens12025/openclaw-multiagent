// dispatch-compat-state.ts — QQ [ACTION] delegate usage history.
//
// Legacy `[DISPATCH]...[/DISPATCH]` has been removed from dispatch-marker.ts;
// this store now tracks only formal `[ACTION] delegate` activity as a small
// historical counter for operator visibility. The file keeps its name and
// location for back-compat with any existing snapshot.

import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

import type { DispatchMarkerFormat } from "./dispatch-marker.js";

export interface QQDispatchCompatState {
  actionDispatchCountLifetime: number;
  lastActionSeenAt: number | null;
  legacyParserRemovedAt: number | null;
}

const STORE_FILE = join(
  homedir(),
  ".openclaw",
  "extensions",
  "qqbot",
  ".dispatch-compat-state.json",
);

const DEFAULT_STATE: QQDispatchCompatState = Object.freeze({
  actionDispatchCountLifetime: 0,
  lastActionSeenAt: null,
  legacyParserRemovedAt: null,
}) as QQDispatchCompatState;

function normalizeState(raw: unknown): QQDispatchCompatState {
  if (!raw || typeof raw !== "object") {
    return { ...DEFAULT_STATE };
  }
  const entry = raw as Partial<QQDispatchCompatState>;
  return {
    actionDispatchCountLifetime: Number.isFinite(entry.actionDispatchCountLifetime)
      ? Number(entry.actionDispatchCountLifetime)
      : 0,
    lastActionSeenAt: Number.isFinite(entry.lastActionSeenAt) ? Number(entry.lastActionSeenAt) : null,
    legacyParserRemovedAt: Number.isFinite(entry.legacyParserRemovedAt)
      ? Number(entry.legacyParserRemovedAt)
      : null,
  };
}

async function readState(): Promise<QQDispatchCompatState> {
  try {
    const raw = await readFile(STORE_FILE, "utf8");
    return normalizeState(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_STATE };
  }
}

async function writeState(next: QQDispatchCompatState): Promise<void> {
  await mkdir(dirname(STORE_FILE), { recursive: true });
  const tmp = STORE_FILE + `.tmp-${randomBytes(4).toString("hex")}`;
  await writeFile(tmp, JSON.stringify(normalizeState(next), null, 2));
  await rename(tmp, STORE_FILE);
}

// Serializes read-modify-write mutations so concurrent dispatch-marker events
// never lose a counter increment.
let mutationChain: Promise<unknown> = Promise.resolve();
function withStateLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = mutationChain.then(fn, fn);
  mutationChain = next.then(() => undefined, () => undefined);
  return next;
}

export async function getQQDispatchCompatState(): Promise<QQDispatchCompatState> {
  return readState();
}

export async function recordDispatchMarkerSeen(
  _format: DispatchMarkerFormat,
  now: number = Date.now(),
): Promise<QQDispatchCompatState> {
  return withStateLock(async () => {
    const prev = await readState();
    const next: QQDispatchCompatState = {
      ...prev,
      actionDispatchCountLifetime: prev.actionDispatchCountLifetime + 1,
      lastActionSeenAt: now,
    };
    await writeState(next);
    return next;
  });
}

export const QQ_DISPATCH_COMPAT_STATE_FILE = STORE_FILE;
