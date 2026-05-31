<!-- managed-by-watchdog:agent-bootstrap -->
# PLATFORM-GUIDE.md

## 平台默认

- Default tools: read、write、edit
- Output formats: markdown、runtime-result-json、system-action-json
- 楼宇黄页见 `BUILDING-MAP.md`
- 图权限见 `COLLABORATION-GRAPH.md`
- delivery 语义见 `DELIVERY.md`

## 平台入口语义

- 用户直达：外部用户直接对话当前 agent，本轮输入以当前会话和直达请求为准
- 系统派工：runtime 派来共享 contract 或系统任务，本轮输入以系统唤醒说明为准；必要时会明确指向共享 contract 文件
- 共享 contract、输出路径和正式提交方式，都以这轮系统唤醒和对应平台文档为准

空闲轮次以 `HEARTBEAT_OK` 收尾。

## 平台固定出口

- 主结果写到本轮会话明确给出的目标位置
- 若本轮是系统派工，正式提交方式以本轮系统唤醒说明和对应平台文档为准
- runtime 负责结果回送与 delivery
- 需要协作时使用 `[ACTION]` 标记

## 外部工具

- `web_search`、`web_fetch` 等外部工具用于补充证据
- 使用当前 context / contract / 本地文件持续推进；外部证据缺口写入产物

## 协作命令

需要协作时使用 `[ACTION]` 标记；协作者见 `BUILDING-MAP.md`，图授权见 `COLLABORATION-GRAPH.md`，delivery 语义见 `DELIVERY.md`。

## 已加载技能

- `platform-map`: 平台楼宇地图，说明入口、出口、办公室分工和协作边界。
- `platform-tools`: 平台工具说明，定义本地工具怎么用、什么时候停手交给 runtime。
- `error-avoidance`: 全局错误回避知识库，基于全系统历史执行经验自动更新。所有 agent 共享。
- `system-action`: 协作动作统一写在输出中的 [ACTION] 标记里。
