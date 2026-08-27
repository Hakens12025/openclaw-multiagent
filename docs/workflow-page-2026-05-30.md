# 前端「工作流」页面 + session 可观测 — 设计稿

> 日期 2026-05-30 · 分支 openclaw-system · 起点 v111-stable
> 目标:新增 dashboard「工作流」页,可视化 agent 工作流 + 直接看每个 agent 的输入/输出与引用文件。

## 已校正前提(重要)
- agent 会话 `.jsonl`(`agents/<agent>/sessions/<uuid>.jsonl`)**已内嵌工具读/写的完整内容**(read 的 toolResult 含文件全文,write 的 toolCall 含写入全文),且**正常运行不被清**(仅测试 `resetRuntimeState` 清,`runtime-admin.js:119`)。
- 被清的只是 `workspaces/<agent>/inbox|outbox/` 工作副本(`agent-end-transport.js:cleanupAgentEndTransport`)。
- 故**不改 session 保存方式、不复制正文**(不造第二真值)。缺口仅:① 把 session 按 contract/workflow 串起来导航;② 引用文件可打开。

## 决策(用户已拍)
- **workflow 定义** = agent-graph 的**连通分量**(从 edges 算),覆盖 planner→worker→worker2 这类线性链;注册 loop 是其子集。
- **文件持久化** = 瘦索引 + 引用正本(contract→`~/.openclaw/contracts/`,output→`control-plane/output/`);只对会被 agent_end 清掉的 **inbox 过滤副本**在清理前快照到 `control-plane/workflow-trace/<contractId>/<agent>/`(它经 `projectTaskFacingInboxContract` 过滤,异于正本,值得留)。
- **推进** = 分期自动建 + 每期串行门 + commit + 汇报。

## 架构(全经 CLI-system,dashboard 只投影)
### 后端 surface(P-WF1)
- `inspect.agent_workflows`:`computeAgentWorkflows(loadGraph())` → `{ workflows:[{id,members,entry}], byAgent:{agentId→workflowId} }`(连通分量,纯函数)。
- `inspect.agent_sessions`(param agentId):读 `sessions.json` → `[{sessionId,sessionKey,contractId,updatedAt,model,totalTokens}]`,`updatedAt` 倒序。
- `inspect.session_transcript`(param agentId,sessionId):解析 `.jsonl` → `{messages:[{role,ts,text,thinking,toolCalls,toolResults}], referencedFiles:[{rawPath,resolvedPath,persistent,kind}]}`;inbox contract→正本、workspace output→ control-plane/output。
- `POST /watchdog/reveal-file`(白名单 `~/.openclaw/{workspaces,control-plane,contracts,agents}`)→ `open -R <path>`(macOS Finder)。
- agent_end 清理前:`snapshotInboxToTrace(contractId,agentId,workspace)`(try/catch,绝不破坏清理)。
- 复用:`inspect.graph_loops`(loop 高亮)、`inspect.agent_graph`、`inspect.tracking_states`/`active_loop_session`、SSE `/watchdog/stream`。

### 前端(P-WF2/3/4)
- nav 加 tab;`workflow.html`/`dashboard-workflow` 页脚本/`.css`;route `/watchdog/workflow-view`（旧 dashboard 前端,已随 v233 前端重制整删,现前端=ui/ 零构建 SPA）。
- 三区:右上**缩略图**(镜像主页,复用 `dashboard-svg`)/ 左**workflow 拓扑**(连通分量,自顶向下,SSE 动态闪)/ 中**session 查看器**(下拉切 session+文件超链接→reveal)。
- 主题:NASA-Punk 变量,扁平(无圆角/阴影/渐变/毛玻璃),`dispatch-pulse`/`data-refresh` keyframe 做闪动。

## 纪律
功能不变红线沿用:串行门 `node --test --experimental-test-module-mocks --test-concurrency=1 --test-timeout=30000 tests/*.test.js` ≤ 基线;不直读 store(经 surface);不造第二真值;每期 commit;收尾跑集成 + tag。
