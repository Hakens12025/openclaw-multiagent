# OpenClaw Multi-Agent System

> openclaw 插件 `openclaw-multi-agent-system`(运行时 id:`watchdog`)。
> 多 Agent 协作编排平台 —— **LLM 管内容,代码管流程**。零外部依赖,纯 Node 内置。

## 第一原则
- **硬路径(代码)**:路由(inbox/outbox/delivery)、状态机(contract / graph-backed loop)、调度(传送带 dispatch / 排队 / 唤醒)、安全(before_tool_call 拦截)、质量门控。
- **软路径(LLM)**:任务理解与拆解、内容产出、自然语言回复。
- **传送带原则**:dispatch/loop 里禁止硬编码 agentId/角色;graph edge = 授权,不是时序;结果回传走 replyTo。

## 架构
**运行时身体(持有业务真值)**:contract / graph / loop / dispatch / delivery / agent。

**四关节自治链(北极星,正在收口)** —— 不是顶层域,是身体之上的控制/演化关节:

```
Harness(工具) ── CLI-system(手) ── Operator(脑) ── Automation(最终目标)
HarnessRun ───────► EvaluationResult ──► AutomationDecision ──► ProfileLifecycle(扩展点)
```

- **Harness = 工具**:拼图化执行塑形(guard/collector/gate/normalizer),只发 `HarnessRun`/证据;不碰协作/delivery/loop/治理真值。
- **CLI-system = 手**:**系统正式可操作表面层**(hook/observe/inspect/apply/verify)= 驾驶舱/仪表盘/检修口/合规操作面。**系统CLI化** = 散落表面收口成同一层。
- **Operator = 脑**:治理消费(读 formal truth+surface → inspect/apply/verify);**不绕过 CLI-system 直写真值**。
- **Automation = 最终目标**:脑-手-工具闭环成熟后自然长出的自治能力。
- **概念预算**:这条线只许 11 个核心概念;冻结接口不冻结大词;不造第二真值;不让任一层越界。

## 目录
```
index.js              插件入口(register + 接线 hooks/routes/gateway_start)
lib/                  业务逻辑(域模块)
  agent/ capability/  Agent 装配:binding/role/profile/skills
  routing/ transport/ 传送带 dispatch + delivery + wake
  loop/ stage-*       graph-backed loop + stage 真值
  lifecycle/ runtime/ hook 生命周期 + 执行观测
  harness/            执行塑形工具(工具)
  cli-system/         正式可操作表面(手)
  operator/           治理消费(脑)
  automation/ schedule/ 自治演化(目标)
  contracts.js store/ 合约真值 + 持久化
  core/               常量/状态/归一(CONTRACT_STATUS 等)
  dev/                system-block-registry(开工纪律)
hooks/                before/after-tool-call, before-agent-start, agent-end
routes/               HTTP 路由(api / operator-catalog / a2a / dashboard)
dashboard-*.js/css    NASA-Punk 前端投影(只投影,不持有真值)
tests/                297 个 node:test 单测文件
test-runner.js        集成测试入口(8 preset, 默认 health)
```

## 安装
在 `openclaw.json` 注册:`"plugins": { "entries": { "watchdog": { "enabled": true } } }`,
随 `openclaw gateway` 加载。

## 测试
```bash
# 单元(必须串行 + flag,确定性)
node --test --experimental-test-module-mocks --test-concurrency=1 --test-timeout=30000 tests/*.test.js
# 集成(网关需在跑): 8 个预设 health/dispatch/pipeline/loop/system-action/operator/knowledge/full
node test-runner.js                     # 默认 health(零 LLM 系统体检)
node test-runner.js --preset dispatch   # 最小 live 派工
node test-runner.js --preset full       # 7 个 suite 全量串行
node test-runner.js --list              # 打印 live 预设表
```
检查产出 CheckResult；fail/blocked/skip 必带 `E-*` 错误码(注册表 `lib/formal-runtime/error-codes.js`)。
报告 `~/.openclaw/test-reports/devtool-<presetId>-<ts>.txt`(failures-first) + `.json`(机器镜像)。

## 文档
- `wiki/concepts/` — 编译知识(WHY),四关节见 harness/cli-system/operator/automation-of-automation + evaluation-result-chain
- `use guide/` — 历史备忘录(RAW),四层联动见备忘录 110-115
- `docs/system-blocks/` — 11 个维护板块 handoff
