// ci-workflow.test.js — CI 矩阵的结构守卫(防 .github/workflows/ci.yml 被静默删/被削矩阵)。
//
// 钉住的是产品面承诺:macOS+Linux 双 OS × node 22/24 双档、离线跑 watchdog npm test、
// push + workflow_dispatch 双触发、以及 checkout→$HOME/.openclaw 的布局同构技法
// (state-paths.js 固化 homedir()/.openclaw,少了 HOME 重定向整个矩阵测的就不是这棵树)。
// 断言走原文正则(仓库零依赖,不引 yaml 解析器),对格式宽容、对承诺零宽容。
// 反证:改名 ci.yml → 首条即红;削掉 macos-latest / node "24" → 对应断言红。

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const CI_YML = fileURLToPath(new URL("../../../.github/workflows/ci.yml", import.meta.url));

async function loadCiYml() {
  try {
    return await readFile(CI_YML, "utf8");
  } catch {
    assert.fail(`.github/workflows/ci.yml 缺席(${CI_YML})—— CI 矩阵被删或被挪窝`);
  }
}

test("ci.yml 存在且触发面 = push + workflow_dispatch", async () => {
  const raw = await loadCiYml();
  assert.match(raw, /^\s*push:/m, "push 触发被削");
  assert.match(raw, /^\s*workflow_dispatch:/m, "workflow_dispatch 手动触发被削");
});

test("ci.yml OS 矩阵含 ubuntu-latest 与 macos-latest 两档", async () => {
  const raw = await loadCiYml();
  assert.match(raw, /os:\s*\[[^\]]*ubuntu-latest[^\]]*\]/, "os 矩阵缺 ubuntu-latest");
  assert.match(raw, /os:\s*\[[^\]]*macos-latest[^\]]*\]/, "os 矩阵缺 macos-latest");
});

test("ci.yml node 矩阵含 22 与 24 两档", async () => {
  const raw = await loadCiYml();
  assert.match(raw, /node:\s*\[[^\]]*"22"[^\]]*\]/, "node 矩阵缺 22(node:sqlite 地板档)");
  assert.match(raw, /node:\s*\[[^\]]*"24"[^\]]*\]/, "node 矩阵缺 24");
});

test("ci.yml 跑的是 watchdog npm test,且布局同构(checkout 到 home/.openclaw + HOME 重定向)", async () => {
  const raw = await loadCiYml();
  assert.match(raw, /run:\s*npm test/, "npm test 步骤被删");
  assert.match(raw, /working-directory:\s*home\/\.openclaw\/extensions\/watchdog/, "工作目录不再指向 watchdog");
  assert.match(raw, /path:\s*home\/\.openclaw/, "checkout path 不再是 home/.openclaw(布局同构被拆)");
  assert.match(raw, /HOME:\s*\$\{\{\s*github\.workspace\s*\}\}\/home/, "HOME 重定向被删 —— 单测将跑在 runner 真 HOME 上");
});
