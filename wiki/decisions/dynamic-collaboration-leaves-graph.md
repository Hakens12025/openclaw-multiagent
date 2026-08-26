# 动态协作不查图边

> 图是固定管线的定义(手连的那条路);agent 主动发起的协作自己指定目标,不受图约束。

## 决策

拆掉 `lib/system-action/collaboration-policy.js` 里 `assign_task` / `request_review` / `wake_agent` 受理时的 `hasDirectedEdge` 校验。

受理时刻的拒绝**保留**,但瞄准的东西换了:目标 agent 不存在 → 结构化拒绝(打错名字在同一轮可见),而不是"拓扑不允许"。

## 原因

**这不是新设计,是代码回到自己的设计。** 三处证据:

- spec §0 红线原话:「固定=**图/代码**,动态=agent **在授权内**」——两半的分工写清了
- spec §5 授权单源是 `collaboration-intent-policy` **一表四消费**,四个消费点没有一个是图
- `lib/routing/runtime-authority.js` 的 `hasRuntimeGraphBypassAuthority` ——**绕图机制本来就存在**(当时两腿:`system_action_delivery` / `loop_start`),只是没接到 FC 受理这一环;`prepareCollaborationTarget` 连 `runtimeAuthority` 参数都不收。（2026-08-18：`loop_start` 腿随回路退役整块删除,唯一合法生产者消失后留旁路比留死码更危险;现在只剩 `system_action_delivery` 一腿。）

**而拿图当动态协作的闸会自毁。** 同一张图被三个消费者读,要求相反:

| 消费者 | 要求 |
|---|---|
| ingress 首跳 | 出边**恰好 1** |
| `agent_end` 自动选路 | 恰好 1 才路由,≥2 弃权 |
| 动态协作授权 | **越多越好** |

要让 FC 够得着就得连成网,连成网就把固定管线全判成歧义。实测:给 controller 加第二条出边,dispatch 立刻 **0 pass / 2 fail / 6 blocked**,注入阶段返回 `no graph out-edge from source agent`。

## 替代方案

**保留图闸 + 给每个工具补边**:实测即上面那条,自毁。

**两张图(授权图 / 管线图)**:真值分裂,而且用户手连的唯一性会被稀释成两份。

**边加用途标记**(采用):一张图两种读法,`metadata.pipeline` 只影响自动选路,授权面读全部边。真值单值,用户手连仍然唯一。

## 影响

- [Graph & Edge](../concepts/graph-edge.md):一句话定义重写,"没有边就不能交互"作废
- [传送带](../concepts/conveyor-belt.md):选路权划分更清晰——固定=图,动态=发起方
- 两条行为锁改写(`system-action-context.test.js` / `review-lane-semantics.test.js`),现在锁新规则的两面:空图不拦、未知目标仍拒
- 死代码清理:`emitGraphCollaborationBlocked` 及其 `EVENT_TYPE.GRAPH_COLLABORATION_BLOCKED` 失去全部消费者

## 出处

`源: 备忘录135 §一` · 用户裁定 2026-08-08 · v179-stable
