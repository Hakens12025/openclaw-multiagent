# Harness Assurance

> Block ID: `harness-assurance` | Type: `core`

> **已退役 v226（2026-08-23）**：harness 判定账已全退役（代码全删），裁决与施工单见
> `use guide/备忘录149_[主]_裁决_阶段012开工与harness全退役_2026-08-20-0130.md` 与
> `use guide/备忘录150_[主]_评审链删除与reviewer角色退役_2026-08-22-2212.md`。
> 本页保留作历史设计记录；其中「标准化」思想（声明式模块、证据归一、配置即契约）仍然有效。
## Responsibility

Own execution shaping, evidence capture, failure classification, and review bridge.

## Owned Truth

- HarnessRun
- module evidence
- failure classification
- review bridge payload

## Interfaces

- harness module contract
- harness runner
- evaluation bridge

## Normal Files

The canonical file ownership rules live in `extensions/watchdog/lib/dev/system-block-registry.js`. Use this page for agent handoff and use the registry for automated checks.

## Boundaries

- This block observes and shapes execution evidence.
- It does not own dispatch queue truth, delivery truth, or automation governance.

## Minimal Tests

- 当时为 `harness-module-contract.test.js` 与 `harness-module-runner.test.js`（两测试已随 v226 harness 退役一并删除，仅存于 git 历史）

## Agent Assignment

Assign this block when changing how execution is observed, shaped, or judged as evidence.

Before implementation, run:

```bash
node scripts/openclaw-block-check.js --primary harness-assurance
```

