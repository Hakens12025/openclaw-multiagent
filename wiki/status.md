# 项目状态

> 最后更新: 2026-04-14

## 当前位置

- 最近完成的活跃收口：备忘录114/115（四层联动编译版 + HarnessModule 接口冻结入口）
- one-shot runtime truth 已进入运行时主链
- CLI system 第一版统一 registry 已落地
- 备忘录进度: 115 号
- Wiki: active concepts / decisions 已开始按四层联动编译版对齐

## 当前活跃拓扑

controller + planner(+plan2) + worker(+worker2) — 无专职 reviewer/researcher/contractor

## 当前最直接的架构债务

1. **`system_action / 角色唤醒 / 外部直达入口` 总规约未最终钉死** — 三条路径仍缺最后一份统一规则
2. **`HarnessModule` 接口还没正式冻结** — definition / input / result 仍散在实现里
3. **one-shot 中层对象消费面未彻底闭合** — `ExecutionObservation / TerminalOutcome` 仍需继续向 harness / automation / lifecycle 投影统一
4. **深水区仍缺一条真实端到端样例** — `Harness -> CLI system -> Operator -> Automation` 还未完整压测

## 阻塞关系

```
system_action / 角色唤醒 / 外部直达入口 总规约未定
  → 协作入口语义仍可能继续分叉

one-shot 中层对象消费面未闭合
  → harness / automation / lifecycle projection 难以完全共用同一真值
```

## 方向已冻结、接口待实现的重要对象

| 对象 | 来源 | 状态 |
|------|------|------|
| WakeEvent → WakeRule → WakeDecision | 备忘录84 | 概念设计完成 |
| ExecutionObservation + TerminalOutcome | 备忘录100 | 主干已部分落地，仍待消费面继续统一 |
| AutomationDecision + ProfileLifecycle | 备忘录80 | 方向稳定，接口未落地 |
| reviewPolicy schema | 备忘录88 | 概念设计完成 |
| AgentGroup 图原语 | 备忘录85 | 概念设计完成 |
| HarnessModule formal interface | 备忘录115 | 入口已建立，待写 schema / tests |

## 下一步建议

1. 先冻结 `HarnessModule` 正式接口和 `CLISurface` schema
2. 再把 `system_action / 角色唤醒 / 外部直达入口` 的统一规则钉死
3. 跑一条真实 `Harness -> CLI system -> Operator -> Automation` 样例
4. 每轮实现后立即更新 active wiki / active guide
