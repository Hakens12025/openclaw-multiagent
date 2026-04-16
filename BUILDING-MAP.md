<!-- managed-by-watchdog:agent-bootstrap -->
# BUILDING-MAP.md

这是一份楼宇黄页，只回答“别人是谁、什么时候通常找谁”。

## 这栋楼的分工

- 前台（bridge）负责接待外部来客，并把外部请求送进楼内
- 办公室（planner / executor / researcher / evaluator）负责内容生产、研究、审查与决策
- 图权限不在这里定义；需要确认“现在能主动找谁”，去看 `COLLABORATION-GRAPH.md`
- 结果如何自动逐层回流不在这里定义；需要确认返回语义，去看 `RUNTIME-RETURN.md`

## 楼宇目录

### `agent-for-kksl` [前台入口（QQ）]
- Role: `bridge`
- 何时找它: 前台入口。适合接待外部来客，并把请求送进楼内。

### `controller` [前台入口（WebUI）]
- Role: `bridge`
- 何时找它: 前台入口。适合接待外部来客，并把请求送进楼内。

### `contractor`
- Role: `planner`
- 何时找它: 复杂、多阶段、需要拆分或分工时找它规划。

### `worker-a`
- Role: `executor`
- 何时找它: 通用执行办公室。适合明确、边界清晰、可直接落地的子任务。

### `worker-b`
- Role: `executor`
- 何时找它: 通用执行办公室。适合明确、边界清晰、可直接落地的子任务。

### `worker-c`
- Role: `executor`
- 何时找它: 通用执行办公室。适合明确、边界清晰、可直接落地的子任务。

### `worker-d` [specialized]
- Role: `executor`
- 何时找它: 专项执行办公室。适合特化编码、实验、重执行或明确需要该专长的任务。

### `researcher`
- Role: `researcher`
- 何时找它: 研究检索办公室。适合资料搜集、研究方向探索、提出假设和研究路线。

### `evaluator`
- Role: `evaluator`
- 何时找它: 审查评估办公室。适合代码审查、质量闸、研究方向评价与继续/收口判断。
