# Vendor 基线：openclaw 与 pi 执行栈（2026-08-16）

学 dsh 的 vendor 纪律（vendor/README.md：钉版 + 逐条修改日志 + 关键面清单）。
我们不 vendor 源码,但对执行栈依赖建立同等的「关键面清单 + 已知行为记录」。
升级任何一项前,对照本文件逐条核对关键面是否变化,并在下方日志追加一条。

## 钉版清单

| 包 | 版本 | 位置 | 角色 |
|---|---|---|---|
| openclaw | 2026.3.2 | 全局 npm (nvm node v25.6.1) | 平台壳:通道桥接/插件宿主 |
| @mariozechner/pi-agent-core | (随 openclaw 锁定) | openclaw/node_modules | **agent loop 本体**(dist 992 行) |
| @mariozechner/pi-coding-agent | (随 openclaw 锁定) | 同上 | 工具集/session-manager/compaction(dist 31,679 行) |
| @mariozechner/pi-ai | (随 openclaw 锁定) | 同上 | provider 抽象/EventStream(dist 21,021 行) |

## 关键面清单（升级必核对）

pi-agent-core `dist/types.d.ts` 的 AgentLoopConfig——我们未来降级式治理的全部抓手:
- `convertToLlm(messages)` **必填**:每次 LLM 调用前重写消息数组(spill 类落点)
- `transformContext(messages, signal)`:官方注释即 "Context window management (pruning old messages)"(compaction 落点)
- `getSteeringMessages()`:每次工具执行后调用,返回消息则注入并跳过剩余工具调用(劝告式 loop-breaker 落点)
- `getFollowUpMessages()`:agent 停止前追加轮次
- `getApiKey(provider)`:动态 key(短时 OAuth 场景)
- `agentLoop()` / `agentLoopContinue()`:dist/agent-loop.d.ts 仅此两导出

宿主 hook 面（2026-08-16 审计核实）:
- PluginHookName 联合类型含 `gateway_stop`(plugin-sdk types.d.ts:262),SIGTERM/SIGINT→runGatewayStop 链路完整
- **hook handler 异常被宿主吞**(hook-runner catchErrors:true→一行 logger.error;register() 抛错=插件跳过、网关照常跑)——hook 内 fail-loud 必须自己造响(error 日志+SSE alert),裸 throw 是哑炮

## 已知行为记录

- watchdog 对执行面的全部控制只经 openclaw 的 hook 事件;pi 的上述钩子
  是否被 openclaw 透传给插件配置,**尚未核实**(2026-08-15 会话结论)——升级或
  做降级治理前必须先查这一条。
- openclaw dependencies 含大量通道 SDK(slack/line/telegram/whatsapp/discord 等),
  升级主要风险面在通道桥接,而非 pi 执行栈本身。

## 升级日志

| 日期 | 动作 | 关键面变化 | 核对人 |
|---|---|---|---|
| 2026-08-16 | 建立基线 | — | (建档) |
