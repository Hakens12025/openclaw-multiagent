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

- `temporary-test-loop` [inactive] entry=`planner`; nodes=`planner` → `worker`; missingEdges=`planner->worker`、`worker->planner`

## 使用原则

- 先用 `BUILDING-MAP.md` 选候选协作者，再用这份文档确认当前权限
- 只沿图上的出边发起显式 agent-to-agent 协作
- loop 是图上的推进结构，由 runtime 执行
