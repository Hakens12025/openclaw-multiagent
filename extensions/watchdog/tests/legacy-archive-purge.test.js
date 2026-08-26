// Tests: boot 断代清扫器(批③B 新能力锁,2026-08-16 审验补齐)。
//   purgeLegacyArchiveStores 是 boot 无条件 rm -rf——破坏性路径必须锁死封闭集:
//   只删 session-archive/ 与 workflow-trace/ 两个死店,毗邻的树店/证据店零触碰。
//
// Run: node --test tests/legacy-archive-purge.test.js

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { purgeLegacyArchiveStores } from "../lib/lifecycle/legacy-archive-purge.js";

const silentLogger = { info() {}, warn() {}, error() {} };

test("清扫器只删两个死店,毗邻店零触碰;重复清扫幂等", async () => {
  const root = await mkdtemp(join(tmpdir(), "legacy-purge-"));
  const dead1 = join(root, "session-archive");
  const dead2 = join(root, "workflow-trace");
  const alive = [
    join(root, "threads", "t-x", "runs", "r-1", "participants"),
    join(root, "trace"),
    join(root, "output"),
  ];
  for (const dir of [join(dead1, "planner"), join(dead2, "TC-1", "planner"), ...alive]) {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "keep.txt"), "x\n", "utf8");
  }

  const first = await purgeLegacyArchiveStores({ logger: silentLogger, rootDir: root });
  assert.equal(first.purged, 2, "两个死店必须都被清");
  assert.equal(existsSync(dead1), false);
  assert.equal(existsSync(dead2), false);
  for (const dir of alive) {
    assert.equal(existsSync(join(dir, "keep.txt")), true, `毗邻店被误删=清扫器越界: ${dir}`);
  }

  const second = await purgeLegacyArchiveStores({ logger: silentLogger, rootDir: root });
  assert.equal(second.purged, 0, "死店已空时清扫必须幂等 no-op");
});
