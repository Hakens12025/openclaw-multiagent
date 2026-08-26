// W2 修复测试 — execution-hard-stop-registry.js:97-103 滑动窗口驱逐 bug
//
// 复现条件：
//   1. 向 session 插入 WINDOW_SIZE(20) 个不同 hash（窗口满）
//   2. 对其中第一个 hash 重复调用 4 次（count=5，即将 hard_stop）
//   3. 再插入一个全新 hash（触发驱逐逻辑）
//
// 修复前：Map.set(existingKey) 不更新插入顺序，第一个 hash 仍是"最旧"的键。
//         新 key 进来时：size 先变 21，然后驱逐"最旧"的那个 → 正是 count=5 的目标 hash
//         被驱逐归零，hard_stop 永不触发。
//
// 修复后：每次更新计数时先 delete 再 set，刷新插入顺序，目标 hash 变成"最新"的键，
//         真正最旧的别的 hash 被驱逐，count 正常累积至 hard_stop。
import test from "node:test";
import assert from "node:assert/strict";

import {
  trackToolCall,
  isSessionHardStopped,
  clearAllSessions,
} from "../lib/runtime/execution-hard-stop-registry.js";

// WINDOW_SIZE=20, STOP_THRESHOLD=5
test("滑动窗口驱逐 bug：高频 hash 在窗口满时不被新调用驱逐归零，应触发 hard_stop", () => {
  clearAllSessions();
  const sk = `window-evict-bug-${Date.now()}`;

  // 步骤 1：填满窗口（20 个不同 hash）
  for (let i = 0; i < 20; i++) {
    const r = trackToolCall(sk, "fill", { slot: i });
    assert.equal(r, null, `填充阶段 slot=${i} 不应触发告警`);
  }

  // 步骤 2：对第一个 hash（fill:{slot:0}）再调 4 次，累计 count=5
  // 注意：第一次已经在步骤 1 中调过（count=1），现在再调 4 次 → count=5
  trackToolCall(sk, "fill", { slot: 0 }); // count=2
  trackToolCall(sk, "fill", { slot: 0 }); // count=3 → warn
  trackToolCall(sk, "fill", { slot: 0 }); // count=4 → warn
  // 此时 count=4，再来一次应该是 hard_stop
  // 但如果窗口此时满了且 fill:{slot:0} 是最旧键，先来一个新 key 会驱逐它
  // 先插一个新 key 触发驱逐（窗口目前有 20 个 key：fill:0 ~ fill:19）
  // fill:0 的 count 此时已经是 4，若被驱逐就会归零
  trackToolCall(sk, "interloper", { z: 999 }); // 新 hash → 窗口溢出 → 驱逐"最旧"

  // 步骤 3：再调一次 fill:{slot:0}，若 bug 存在则 count 从 0 重新开始（null），
  //         若修复则 count=5 → hard_stop
  const result = trackToolCall(sk, "fill", { slot: 0 });

  assert.equal(result, "hard_stop", "fill:{slot:0} 累计 5 次必须触发 hard_stop，不能因窗口驱逐归零");
  assert.equal(isSessionHardStopped(sk), true, "session 必须被标记为 hardStopped");
});

// 对照：正常场景不受影响
test("正常场景：同一 hash 重复 5 次（无其他干扰）仍触发 hard_stop", () => {
  clearAllSessions();
  const sk = `normal-stop-${Date.now()}`;
  for (let i = 0; i < 4; i++) trackToolCall(sk, "read", { p: "/x" });
  const r = trackToolCall(sk, "read", { p: "/x" }); // count=5
  assert.equal(r, "hard_stop");
  assert.equal(isSessionHardStopped(sk), true);
});
