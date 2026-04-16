<!-- managed-by-watchdog:agent-bootstrap -->
# COLLABORATION-GRAPH.md

这份文档只回答：你现在能主动找谁，以及哪些显式协作动作受图约束。

## 当前图权限

- 你可直接调用: 当前无显式出边
- 可直接调用你: 当前无显式入边
- `assign_task` / `wake_agent` / `request_review` 这类显式点对点协作，都先看这份图权限
- 是否允许某个动作，还要同时遵守 `SOUL.md` 和对应 skill 的角色边界

## 当前显式回路

- 当前不在显式回路中

## 已登记回路

- `live-loop-direct-1774404127019` [active] entry=`researcher`; nodes=`researcher` → `worker-d` → `evaluator`
- `live-loop-direct-1774404970259` [active] entry=`researcher`; nodes=`researcher` → `worker-d` → `evaluator`
- `live-loop-direct-1774405209378` [active] entry=`researcher`; nodes=`researcher` → `worker-d` → `evaluator`
- `live-loop-direct-1774406039179` [active] entry=`researcher`; nodes=`researcher` → `worker-d` → `evaluator`
- `live-loop-direct-1774406329025` [active] entry=`researcher`; nodes=`researcher` → `worker-d` → `evaluator`
- `live-loop-direct-1774406591112` [active] entry=`researcher`; nodes=`researcher` → `worker-d` → `evaluator`
- `live-loop-direct-1774407090809` [active] entry=`researcher`; nodes=`researcher` → `worker-d` → `evaluator`
- `live-loop-direct-1774408196908` [active] entry=`researcher`; nodes=`researcher` → `worker-d` → `evaluator`
- `live-loop-fullcycle-1774410962506` [active] entry=`researcher`; nodes=`researcher` → `worker-d` → `evaluator`
- `live-loop-fullcycle-1774411938205` [active] entry=`researcher`; nodes=`researcher` → `worker-d` → `evaluator`
- `live-loop-fullcycle-1774412267654` [active] entry=`researcher`; nodes=`researcher` → `worker-d` → `evaluator`
- `real-runtime-loop` [active] entry=`researcher`; nodes=`researcher` → `worker-d` → `evaluator`
- `research-loop` [active] entry=`researcher`; nodes=`researcher` → `worker-d` → `evaluator`
- `test-live-loop` [active] entry=`researcher`; nodes=`researcher` → `worker-d` → `evaluator`

## 使用原则

- 先用 `BUILDING-MAP.md` 选候选协作者，再用这份文档确认当前权限
- 没有图上的出边，不要主动发起显式 agent-to-agent 协作
- loop 是图上的推进结构，不是私有旁路协议
