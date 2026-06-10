# Test System

> test-runner.js 是唯一测试入口，禁止手动 curl；一切检查产出 CheckResult，失败必带 E-* 错误码。

## 是什么

OpenClaw 的测试基础设施，覆盖从单元到端到端的多层验证：

**入口与预设（CheckResult 体系，2026-06-10 重写）：**
- `test-runner.js` — 唯一集成测试入口，`/watchdog/test-runs/*` 的薄客户端
- 默认预设：`node extensions/watchdog/test-runner.js`（= `health`，零 LLM 系统体检）
- 8 个预设：`health/dispatch/pipeline/loop/system-action/operator/knowledge/full`
  （真值在 `lib/formal-test-presets.js`，suite 驱动在 `lib/formal-runtime/checks/`）
- 发现：`--list` 打印 live 预设表；`--help` 打印用法；单用例 `--case <id>`（仅 dispatch/pipeline）
- 旧 `--suite` / `--filter` / `--clean` 参数已退役，传入会 hard error

**CheckResult 与错误码：**
- 每个检查产出 CheckResult：`{id, subsystem, title, status, code, evidence, hint, durationMs}`
- 四种状态：`pass / fail / skip / blocked` — skip = 前置条件使检查无意义（如 ollama 不在）；
  blocked = 前置失败导致无法运行（如 gateway down 阻塞全部 GW 检查）
- fail/blocked/skip 必须引用注册过的 `E-<SUBSYS>-<NNN>` 错误码，单一注册表
  `lib/formal-runtime/error-codes.js`；hint 指向具体真值文件/路由，让 agent 只读报告即可诊断
- 退出码：0 = 全部 pass，1 = 有 fail，2 = 有 blocked

**报告（failures-first）：**
- `~/.openclaw/test-reports/devtool-<presetId>-<ts>.txt` — VERDICT → FAILURES FIRST
  （每个 fail/blocked 展开 E-code/evidence/hint）→ 各子系统通过项每行一条
- 同名 `.json` — 机器可读镜像 `{presetId, verdict, totals, checks[]}`
- suite 永不自己写报告；渲染统一在 `lib/formal-runtime/formal-report.js`

**关键纪律：**
- 测试验证平台通用能力，不验证特定 prompt 能否把 Agent 推上正确路径
- 合成/对象测试只证明局部机制，不能声称平台整体可用
- 失败测试不得污染下一个测试（live suite 用 fullReset；只读 suite `cleanMode:"none"` 不 reset，
  因为 reset 本身会留下体检要捕捉的残留）
- 测试注入通过 `/watchdog/tests/inject` 端点（verify surface `test.inject`）

## 为什么存在

- 多 Agent 系统的失败模式极其隐蔽，没有自动化测试就是盲飞
- 手动 curl 测试不可复现、不可追踪、容易遗漏检查点
- BLOCKED/SKIP 状态区分"系统问题"和"外部环境问题"，避免误报
- 错误码注册表 + failures-first 报告让零上下文 agent 不盯进程也能从一份报告定位真值源

## 和谁交互

| 概念 | 关系 |
|------|------|
| [Hard-Soft Path](hard-soft-path.md) | CheckResult 和错误码属于 hard-path 验证 |
| [Harness](harness.md) | Harness 提供 Agent 级别的执行框架，test-runner 与其正交 |
| [Dashboard](dashboard.md) | Devtools 面板提供测试发起 UI（按 live 预设表渲染按钮） |
| [Operator](operator.md) | apply 后强制 verify 走 `test_runs.start`，共享 verify 预设 `dispatch` |

## 演化

1. 早期：手动 curl 测试
2. test-runner.js 引入：统一入口，预设制
3. 备忘录67：五层测试模型确立，测试纪律固化
4. 深度审查：6 个 P0 结构性 bug 修复；BLOCKED 状态引入
5. 旧体系膨胀到 19 个预设（single/qq-*/random-*/concurrent/direct-service…），13 检查点 +
   E_HOOK_MISS 系错误码，诊断目录在两处漂移
6. 2026-06-10：CheckResult 重写 — 19 预设收敛为 8（health 为默认零 LLM 体检），
   错误码收口单一注册表，报告 failures-first + JSON 镜像；verify 门预设 `single`→`dispatch`
   （`lib/admin/admin-surface-registry.js`）；旧 suite/random/tsp 机器整体删除

## 当前状态

**功能完整，刚完成 CheckResult 重写。** 单元门 297 文件 ~1900 测试全绿；
报告契约 `formal-check-report/v1`。
