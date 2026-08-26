// tests/store-root-sentinel.test.js — 店根门卫(核心设计指标§13,备忘录158 §五)。
// 判定属主=control-plane-paths.resolveOwnedStorePath,三级优先:显式种子 > 测试进程沙箱 > 生产根。
// 本测试**故意不 import seed-tree-stores**:它测的就是"没有种子时门卫自己站岗"。
// 五次生产树污染事故(最近 2026-08-26 TC-TERMINALIZE 夹具)全部走"手跑测试无种子"通道,
// 门卫让该通道结构性免疫——忘导种子的后果从"污染生产"降为"落进程级沙箱"。
import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";

import { CONTROL_PLANE_PATHS, resolveOwnedStorePath } from "../lib/control-plane/control-plane-paths.js";
import { resolveThreadsRoot, resolveContractIndexFile } from "../lib/archive/thread-tree-store.js";
import { resolveSessionIndexFile } from "../lib/archive/session-home-index.js";
import { resolveDefaultLedgerPath } from "../lib/store/delivery-idempotency-store.js";
import { resolveDefaultTicketDir } from "../lib/routing/delivery/delivery-ticket-store.js";
import { resolveAgentGraphFile } from "../lib/agent/agent-graph.js";
import { resolveRecordDbPath } from "../lib/record-plane/database.js";

const STORE_ENV_KEYS = [
  "OPENCLAW_THREADS_DIR",
  "OPENCLAW_CONTRACT_INDEX_FILE",
  "OPENCLAW_SESSION_INDEX_FILE",
  "OPENCLAW_DELIVERY_LEDGER_FILE",
  "OPENCLAW_DELIVERY_TICKET_DIR",
  "OPENCLAW_AGENT_GRAPH_FILE",
  "OPENCLAW_RECORD_DB",
];

// npm test 全局设了这些 env(那是显式种子层);要测门卫的沙箱层必须临时摘掉,finally 复原。
function withEnv(patch, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(patch)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}
const clearAllStoreEnv = () => Object.fromEntries(STORE_ENV_KEYS.map((k) => [k, undefined]));

test("测试进程无显式种子 → 全部店根落进程级沙箱,绝不落生产 control-plane", () => {
  withEnv(clearAllStoreEnv(), () => {
    assert.ok(process.env.NODE_TEST_CONTEXT, "前提:node:test 恒注入 NODE_TEST_CONTEXT");
    const resolved = {
      threads: resolveThreadsRoot(),
      contractIndex: resolveContractIndexFile(),
      sessionIndex: resolveSessionIndexFile(),
      ledger: resolveDefaultLedgerPath(),
      tickets: resolveDefaultTicketDir(),
      graph: resolveAgentGraphFile(),
      recordDb: resolveRecordDbPath(),
    };
    for (const [name, p] of Object.entries(resolved)) {
      assert.ok(!p.startsWith(CONTROL_PLANE_PATHS.root), `${name} 不得落生产 control-plane: ${p}`);
      assert.ok(p.startsWith(tmpdir()) || p.includes("openclaw-teststore-"), `${name} 应落沙箱: ${p}`);
    }
    // 同进程沙箱根稳定(两次解析同根,店间互相可见——夹具跨店一致性)
    assert.equal(resolveThreadsRoot(), resolved.threads, "同进程重复解析同根");
  });
});

test("显式种子(OPENCLAW_*)优先于沙箱 — npm test/seed-tree-stores 的显式层照旧生效", () => {
  withEnv({ ...clearAllStoreEnv(), OPENCLAW_THREADS_DIR: "/tmp/explicit-threads-x" }, () => {
    assert.equal(resolveThreadsRoot(), "/tmp/explicit-threads-x", "显式种子赢");
    // 其余未显式的仍走沙箱
    assert.ok(!resolveAgentGraphFile().startsWith(CONTROL_PLANE_PATHS.root), "未显式者仍沙箱");
  });
});

test("非测试进程(无 NODE_TEST_CONTEXT)且无种子 → 生产根(网关/CLI 行为不变)", () => {
  withEnv({ ...clearAllStoreEnv(), NODE_TEST_CONTEXT: undefined }, () => {
    assert.equal(resolveThreadsRoot(), CONTROL_PLANE_PATHS.threadsDir, "生产树根");
    assert.equal(resolveAgentGraphFile(), CONTROL_PLANE_PATHS.agentGraphFile, "生产图");
    assert.equal(resolveRecordDbPath(), `${CONTROL_PLANE_PATHS.root}/records.db`, "生产账");
  });
});

test("属主唯一:七店解析函数全部经 resolveOwnedStorePath(源码守卫,私判不得复活)", async () => {
  const { readFile } = await import("node:fs/promises");
  const sites = [
    "../lib/archive/thread-tree-store.js",
    "../lib/archive/session-home-index.js",
    "../lib/store/delivery-idempotency-store.js",
    "../lib/routing/delivery/delivery-ticket-store.js",
    "../lib/agent/agent-graph.js",
    "../lib/record-plane/database.js",
  ];
  for (const rel of sites) {
    const src = await readFile(new URL(rel, import.meta.url), "utf8");
    assert.match(src, /resolveOwnedStorePath\(/, `${rel} 必须消费门卫`);
    assert.doesNotMatch(
      src.replace(/\/\/[^\n]*/g, ""),
      /const seeded = process\.env\.OPENCLAW_/,
      `${rel} 不得保留旧式私判(环境直读)`,
    );
  }
});
