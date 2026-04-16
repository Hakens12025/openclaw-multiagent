<!-- managed-by-watchdog:agent-bootstrap -->
# PLATFORM-GUIDE.md

## 平台默认

- Default tools: read、write、edit
- Output formats: markdown、contract-result-json、system-action-json
- 楼宇黄页见 `BUILDING-MAP.md`
- 图权限见 `COLLABORATION-GRAPH.md`
- 回流语义见 `RUNTIME-RETURN.md`

## 平台固定入口

- 第一入口永远是 `inbox/contract.json`
- Contract 会告诉你当前任务、阶段和主输出路径


若这些入口都不存在，通常应直接 `HEARTBEAT_OK`，不要自己扫描整棵目录树。

## 平台固定出口

- 主结果写到 contract 的 `output`
- 失败或补充信息写到 `outbox/contract_result.json`
- 需要协作、委派、启动/推进 loop、唤醒时写到 `outbox/system_action.json`
- 若你的 outbox 是结构化提交，优先补一份 `outbox/_manifest.json` 声明 kind 和 artifact 类型

## 外部工具降级规则

- `web_search`、`web_fetch` 等外部工具是增强能力，不是默认阻塞点
- 若外部工具因无 key、无网络、权限不足或服务异常而失败，只要当前任务还能基于现有 context / contract / 本地文件继续，就继续推进并在产物里注明限制
- 只有当 contract 明确要求外部验证，且缺少该工具就无法满足完成条件时，才写 `outbox/contract_result.json` 说明失败或待补充
- 不要因为一次可选工具失败就停在中间，也不要把“工具不可用”误当成整个任务的终态

## 协作动作入口

常见 platform 动作：

- `create_task`
- `assign_task`
- `request_review`
- `start_pipeline`
- `advance_pipeline`（少用，仅在需要显式改写下一跳时）
- `wake_agent`
- 是否应使用某个动作，先遵守 `SOUL.md` 的角色边界，再看 `COLLABORATION-GRAPH.md` 的当前权限
- 委派和审查结果默认由 runtime 自动回流；具体返回语义看 `RUNTIME-RETURN.md`

原则：

- 自己能完成就自己完成
- 真需要协作时再走 platform
- 不直接写别的 agent 的 `inbox/` 或 workspace

## Typed Outbox Commit

`outbox/_manifest.json` 的最小结构：

```json
{
  "version": 1,
  "kind": "execution_result | research_search_space | evaluation_verdict | evaluation_decision",
  "artifacts": [
    { "type": "stage_result | contract_result | contract_update | text_output | search_space | research_direction | evaluation_verdict | workflow_decision | notes", "path": "文件名", "required": true }
  ]
}
```

当前角色可直接参考这个最小例子：

```json
{
  "version": 1,
  "kind": "execution_result",
  "artifacts": [
    { "type": "stage_result", "path": "stage_result.json", "required": true },
    { "type": "contract_result", "path": "contract_result.json", "required": false }
  ]
}
```

若没有写 `_manifest.json`，平台仍会按历史固定文件名兜底；但新协议优先使用 manifest。

## 已加载技能

- `platform-map`: 平台楼宇地图，说明入口、出口、办公室分工和协作边界。
- `platform-tools`: 平台工具说明，定义本地工具怎么用、什么时候停手交给 runtime。
- `error-avoidance`: 全局错误回避知识库，基于全系统历史执行经验自动更新。所有 agent 共享。
- `system-action`: 平台调度入口，定义 `outbox/system_action.json` 可用动作和基本结构。
