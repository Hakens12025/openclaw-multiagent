# Agent 即分类器

> QQ 消息直接交给 agent LLM 判断意图，不做任何 regex 预分类或 hook 拦截。

## 决策

所有 QQ 消息直接发送给 agent LLM。Agent 配置 `tools.allow:[]`、`skills:[]`（无工具无技能）。
Agent 本身就是分类器 — 自然识别超出能力范围的任务，输出 `[DISPATCH]` 标记触发分发。

## 原因

- Regex 预分类脆弱，无法处理自然语言的模糊性和变体。
- Hook 抑制（suppressed）滥用了 hook 的定位 — hook 是观察者，不是守门人。
- LLM 判断 = 最优意图分类，零额外开销（agent 本来就要接收消息）。

## 否决的替代方案

以下代码/逻辑已全部删除：

- `isSimpleQQMessage()` / `isFastTrackQQMessage()` regex 预分类
- ingress hard-path 预路由拦截块
- `ingressResult?.suppressed` 检查
- `ignoredHeartbeatSessions` guard
- bridge agent 空心跳抑制
- QQ 主会话 `{suppressed: true}` 拦截

## 影响

- **three-layer-protocol**：消息流经协议三层（ingress → conveyor → delivery）不再有旁路。
- **conveyor-belt**：传送带成为唯一分发路径，不存在绕过 conveyor 的快速通道。
- 系统复杂度显著降低，所有消息走同一条路径。

## 出处

备忘录49
