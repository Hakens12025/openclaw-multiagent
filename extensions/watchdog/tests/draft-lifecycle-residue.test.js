import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// 仓内定位:以本文件为锚(tests/ → watchdog 根),不写死机器路径——CI/别机同样可解析。
const wd = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url));

import { EVENT_TYPE } from "../lib/core/event-types.js";

test("runtime surface no longer exposes draft promotion compatibility events", () => {
  assert.equal("DRAFT_PROMOTED" in EVENT_TYPE, false);
  assert.equal("DRAFT_TIMEOUT" in EVENT_TYPE, false);
});

test("dispatch graph policy no longer carries promoteFromDraft compatibility logic", async () => {
  const source = await readFile(wd("lib/routing/dispatch/dispatch-graph-policy.js"), "utf8");

  assert.doesNotMatch(source, /\bpromoteFromDraft\b/);
  assert.doesNotMatch(source, /\bdraft_promoted\b/);
  assert.doesNotMatch(source, /ingress creates PENDING directly/);
});

test("system action suite no longer expects draft_promoted runtime events", async () => {
  const source = await readFile(wd("lib/formal-runtime/suite-collab.js"), "utf8");

  assert.doesNotMatch(source, /\bdraft_promoted\b/);
});

