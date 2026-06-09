/**
 * agent-constraints-conveyor-guard.test.js — agents.constraints 的传送带一致性守卫
 *
 * 传送带强制「每 agent 一次一份」串行（dispatch 仅 state.currentContract 单槽，
 * 见 dispatch-runtime-state.js）。因此 per-agent constraints 里：
 *   - maxConcurrent 只能是 1（>1 的并行旋钮运行时零消费 = 会撒谎的配置）
 *   - serialExecution 不能是 false（永远串行）
 * apply 路径 fail-loud 拒绝，而非静默接受空操作。maxRetry/timeoutSeconds 不受此守卫限制。
 */

import test from "node:test";
import assert from "node:assert/strict";

import { normalizeConstraintPatchInput } from "../lib/agent/agent-admin-defaults.js";

test("maxConcurrent=1 合法（= 串行本身）", () => {
  const patch = normalizeConstraintPatchInput({ maxConcurrent: 1 });
  assert.equal(patch.maxConcurrent, 1);
});

test("maxConcurrent>1 → fail-loud 拒绝（伪并行）", () => {
  assert.throws(
    () => normalizeConstraintPatchInput({ maxConcurrent: 5 }),
    /maxConcurrent=5 unsupported|serial/i,
  );
  assert.throws(
    () => normalizeConstraintPatchInput({ maxConcurrent: 2 }),
    /unsupported|serial/i,
  );
});

test("serialExecution=false → fail-loud 拒绝（永远串行）", () => {
  assert.throws(
    () => normalizeConstraintPatchInput({ serialExecution: false }),
    /serialExecution=false unsupported|serial/i,
  );
});

test("serialExecution=true 合法（与现实一致）", () => {
  const patch = normalizeConstraintPatchInput({ serialExecution: true });
  assert.equal(patch.serialExecution, true);
});

test("maxRetry / timeoutSeconds 不受守卫限制（真约束）", () => {
  const patch = normalizeConstraintPatchInput({ maxRetry: 3, timeoutSeconds: 30 });
  assert.equal(patch.maxRetry, 3);
  assert.equal(patch.timeoutSeconds, 30);
});

test("只设 maxRetry（不带 maxConcurrent/serialExecution）→ 不误触守卫", () => {
  const patch = normalizeConstraintPatchInput({ maxRetry: 1 });
  assert.equal(patch.maxRetry, 1);
  assert.equal(patch.maxConcurrent, undefined);
  assert.equal(patch.serialExecution, undefined);
});
