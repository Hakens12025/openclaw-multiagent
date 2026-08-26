# Graph & Edge

> `agent_graph.json` 是**固定管线**的定义——平台在没有显式目标时靠它决定下一跳。它不再是动态协作的闸。

## 是什么

图定义 agent 之间的有向边。**同一张图今天有两类读法,要求正好相反**:

| 读法 | 谁在读 | 对出边数的要求 |
|---|---|---|
| **固定管线选路** | ingress 首跳 `dispatchResolveFirstHop`、`agent_end` 自动选路 `resolveRouteAfterAgentEndTarget` | **恰好 1 条**(≥2 判 ambiguous 不路由,0 条判 terminal) |
| **授权** | 显式指定目标时的 `hasDirectedEdge` 校验 | 有就行,越多越好 |

`metadata.pipeline: true` 把两者分开:**管线边 = 标了的那些;一条都没标时全部边都是管线边**。回退语义是刻意的——图会被 `/watchdog/reset` 清空(`E-GRAPH-002`)、被测试夹具重建、被人手工重建,硬要求标记会让自动选路对自己的测试夹具变脆。

**动态协作(agent 主动调 `assign_task` / `wake_agent`)不查图边。** 目标由发起方自己指定,受理时只校验"这个 agent 存不存在"。

代码位置:`lib/agent/agent-graph.js`(读原语)、`lib/routing/dispatch/dispatch-graph-policy.js`(选路)、`lib/system-action/collaboration-policy.js`(受理)。

## 为什么存在

**回答"平台在没人可问的时候把活交给谁"。** 外部消息进来时 LLM 还没跑,平台必须自己决定首跳——这个决定需要确定性,所以要求管线边唯一。

**它不再承担"防止 agent 之间无序通信"。** 那条旧理由在实践中自毁:要让动态协作够得着就得把图连成网,而同一张图又驱动首跳和自动选路,连成网就把固定管线全判成歧义。实测把 controller 加到两条出边,ingress 当场返回 `no graph out-edge from source agent`,整条链在门口断掉。

动态协作的约束回到角色策略(`collaboration-intent-policy` 一表四消费),那才是 spec §5 指定的授权单源。

## 和谁交互

- [三层通讯协议](./three-layer-protocol.md):图选路是 `dispatch` 内部策略,不是独立协议族
- [传送带](./conveyor-belt.md):conveyor dispatch 沿管线边搬运
- [AgentBinding](./agent-binding.md):EdgeSpec 是 Assembly 层对象之一
- [Agent Group](./agent-group.md):组内边带 `metadata.groupId`,与本页的 pipeline 标记正交
- 决策页:[动态协作不查图边](../decisions/dynamic-collaboration-leaves-graph.md)

## 演化

1. 备忘录51 确立 graph 为协作真值,强制运行时执行
2. 备忘录83 修复 pool dispatch 未尊重图边(增加 fromAgent 过滤)
3. 备忘录85 提出"图作为编程语言"的类比(sequential / conditional / loop / parallel …)。其中 loop 一项**只落成"图上成环"这一形态**——曾短暂长出的独立回路运行时已于 2026-08-18 退役，见 [Loop（已退役页）](../concepts/loop.md)
4. 备忘录73 将 edges 从 BUILDING-MAP.md 分离为 COLLABORATION-GRAPH.md
5. **v179-stable: 边加 `metadata.pipeline`,一张图两种读法**。此前 planner / worker / researcher1 出度 ≥2 = 自动选路早就是死的,标记后三者既有唯一主路又保有多目标派工。源: 备忘录135 §二
6. **v179-stable: 动态协作解绑图边**。`collaboration-policy.js` 的 `hasDirectedEdge` 拒绝拆除,约束回到角色策略。源: 备忘录135 §一

## 当前状态

**演化中**。管线选路稳定;动态协作已解绑。

**已知留口**:ingress 首跳仍要求管线边唯一,所以 bridge 入口结构上只能有一个自动下家——"无目标的外部消息"仍靠图的确定性。测试期图不是稳定资产(`collab` 预设的 prep 会经 admin API 加边,清理时把原有边一起删)。
