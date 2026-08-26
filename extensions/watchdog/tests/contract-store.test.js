import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveThreadsRoot } from "../lib/archive/thread-tree-store.js";
import {
  cacheContractSnapshot,
  clearContractStore,
  readCachedContractSnapshotById,
  readContractSnapshotByPath,
} from "../lib/store/contract-store.js";

// 共享正本 = 树内 threads/{t}/runs/{r}/contracts/{id}.json,别无他店。
function treeContractPath(contractId) {
  return join(resolveThreadsRoot(), "th-store-test", "runs", "run-store-test", "contracts", `${contractId}.json`);
}

test("contract store indexes cached snapshots by canonical contract id", async () => {
  clearContractStore();
  try {
    // 正本路径必须落在树内 run contracts/ 下：id→path 索引只收共享合约正本。
    // 纯内存缓存，命中后直接返回，不触碰磁盘。
    cacheContractSnapshot(treeContractPath("TC-CANONICAL"), {
      id: "TC-CANONICAL",
      task: "canonical lookup",
    });

    const snapshot = await readCachedContractSnapshotById("tc-canonical", {
      contractPathHint: join("/tmp", "openclaw-contract-store", "missing.json"),
    });

    assert.equal(snapshot?.id, "TC-CANONICAL");
  } finally {
    clearContractStore();
  }
});

// v133「contract.output 镜像」的复发通道：inbox 侧落盘的是窄投影（剥掉 output /
// dispatchDepth 等路由字段），若它占住 id→path 索引，按 id 读真值就会拿到缺字段的副本。
// 触发序列取自 removeInboxContractIfExists 的先验读（preferCache:false → 走磁盘 → 写索引）。
test("inbox 窄投影不得占据 id→path 索引", async () => {
  clearContractStore();
  const tmpRoot = await mkdtemp(join(tmpdir(), "openclaw-contract-store-"));
  const inboxDir = join(tmpRoot, "workspaces", "agent-a", "inbox");
  await mkdir(inboxDir, { recursive: true });
  const inboxPath = join(inboxDir, "contract.json");

  try {
    cacheContractSnapshot(treeContractPath("TC-MIRROR-GUARD"), {
      id: "TC-MIRROR-GUARD",
      status: "running",
      assignee: "agent-a",
      output: "/control-plane/output/TC-MIRROR-GUARD.md",
      dispatchDepth: 3,
    });

    // 与 stageInboxContract 落盘形状一致：只保留 task-facing 字段。
    await writeFile(inboxPath, JSON.stringify({
      id: "TC-MIRROR-GUARD",
      status: "running",
      assignee: "agent-a",
    }), "utf8");

    const projection = await readContractSnapshotByPath(inboxPath, { preferCache: false });
    assert.equal(projection?.output, undefined, "前置条件：inbox 投影确实缺 output");

    const truth = await readCachedContractSnapshotById("TC-MIRROR-GUARD");
    assert.equal(
      truth?.output,
      "/control-plane/output/TC-MIRROR-GUARD.md",
      "按 id 读真值必须解析到共享正本，而不是 inbox 投影",
    );
    assert.equal(truth?.dispatchDepth, 3, "dispatch 深度守卫依赖的字段不得被投影抹平");
  } finally {
    clearContractStore();
    await rm(tmpRoot, { recursive: true, force: true });
  }
});
