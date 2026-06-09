# Provider 兜底链 (Provider Fallback Chain)

> meta-agent brain 的模型解析从"单 provider"升级为"有序就绪链"：provider 类错误时运行时降级到下一个，不重启网关。

## 是什么

`agents.defaults.model.fallback = [providerRef, ...]`（有序）声明 meta-agent brain（operator / viz-master）的兜底 provider。`resolveBrainModelChain(config)`（`lib/brain-model-resolver.js`）解析出 `[primary, ...ready fallbacks]`——非 `openai-completions` / 无 baseUrl / 无 key 的 ref 跳过，fullRef 去重；`callPlannerWithModelFallback`（`lib/operator/operator-brain.js`，operator 与 viz-master 共享）walk 这条链。空 fallback = 旧的单解析行为（向后兼容，`resolveOperatorBrainModel` 字节不变）。

只覆盖 watchdog 自己发起的 brain 调用（operator / viz-master）；worker agent 走 Pi 引擎，不在此路径。

## 为什么存在

持久网关跑无人值守 loop 时，"primary provider 半夜限额 → 全平台规划停摆"是最痛的故障（ARK 限额 / `system busy` socket）。此前救援是手改 `openclaw.json` + 重启网关。兜底链把它变成**运行时降级**：ARK 挂 → 自动切 `glm-bigmodel/glm-5.1`（**跨 provider**——同 ARK 内换模型对限额无用）。这是 [oh-my-pi 借鉴](../decisions/oh-my-pi-borrow-2026-06.md) 的 TIER-1。

**关键边界**：只在 **provider 类错误**（限额/socket/超时/http）兜底；`PLANNER_JSON_PARSE_FAILED`（内容错误，模型答了但不可解析）**不跨 provider**——否则把同一份坏推理换 provider 重跑、错标失败类（尊重 `lib/llm-planner.js` 既有区分）。

## 和谁交互

| 概念 | 关系 |
|------|------|
| [Operator](operator.md) | operator brain 走兜底链 |
| [硬路径与软路径](hard-soft-path.md) | provider 解析/降级是硬路径 |
| [oh-my-pi 借鉴](../decisions/oh-my-pi-borrow-2026-06.md) | 此机制 = 该分析的 TIER-1 |

## 演化

v161-stable: 落地。`resolveBrainModelChain` + `callPlannerWithModelFallback`（operator + viz 共享）；兜底成功 emit `provider_fallback` SSE 事件。源: 备忘录125 §六。

## 当前状态

**已落地（v161）。** 配置 = 全局 `agents.defaults.model.fallback`（live 已设 `["glm-bigmodel/glm-5.1"]`，需网关重启加载新代码）。per-agent 链待 brain-resolver 泛化 per-agent 时加；dashboard 监听 `provider_fallback` 事件的前端白名单待加。
