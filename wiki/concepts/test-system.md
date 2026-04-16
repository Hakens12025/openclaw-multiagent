# Test System

> test-runner.js 是唯一测试入口，禁止手动 curl。

## 是什么

OpenClaw 的测试基础设施，覆盖从单元到端到端的多层验证：

**入口与预设：**
- `test-runner.js` — 唯一测试入口
- 7 种预设：single / multi / concurrent / concurrent-multi / model / research-flow / research-auto
- 5 个 suite：single, concurrent, benchmark, research, model
- 精细控制：`--suite [name] [--filter xxx]`

**检查点与错误码：**
- 13 个检查点（CP1-CP13）
- 错误码范围：E_HOOK_MISS 到 E_CONTRACT_INCOMPLETE
- 三种结果状态：PASS / FAIL / BLOCKED（外部平台阻塞，如 QQ IP 白名单）
- 退出码：0 = 全部 PASS，1 = 真实 FAIL，2 = 仅 BLOCKED

**五层测试模型（备忘录67）：**

| 层级 | 验证对象 |
|------|----------|
| 用户任务 | 端到端用户场景 |
| 平台真值 | 平台通用能力 |
| 传输 | 消息投递与路由 |
| 执行 | Agent 执行逻辑 |
| 观测 | 监控与状态报告 |

**关键纪律：**
- 测试验证平台通用能力，不验证特定 prompt 能否把 Agent 推上正确路径
- 合成/对象测试只证明局部机制，不能声称平台整体可用
- 失败测试不得污染下一个测试（fullReset）
- QQ 测试注入通过 `/watchdog/tests/inject` 端点

**深度审查：**
- 测试系统深度审查发现并修复 6 个 P0 结构性 bug
- Bug 读报告文件（`~/.openclaw/test-reports/`），不 tail 日志

## 为什么存在

- 多 Agent 系统的失败模式极其隐蔽，没有自动化测试就是盲飞
- 手动 curl 测试不可复现、不可追踪、容易遗漏检查点
- 分层测试模型确保每一层都有独立覆盖，不依赖上层通过来推断下层正确
- BLOCKED 状态区分"系统问题"和"外部环境问题"，避免误报

## 和谁交互

| 概念 | 关系 |
|------|------|
| [Hard-Soft Path](hard-soft-path.md) | 检查点和错误码属于 hard-path 验证 |
| [Harness](harness.md) | Harness 提供 Agent 级别的执行框架，test-runner 调用 harness |
| [Dashboard](dashboard.md) | Devtools 面板提供测试注入 UI |

## 演化

1. 早期：手动 curl 测试
2. test-runner.js 引入：统一入口，7 种预设
3. 备忘录67：五层测试模型确立，测试纪律固化
4. 深度审查：6 个 P0 结构性 bug 修复
5. BLOCKED 状态引入：区分外部阻塞和真实失败
6. 测试用例内联到 suite 文件中（无 test-cases.json）

## 当前状态

**功能完整。** 测试覆盖率 7%（备忘录93），持续改进中。13 个检查点活跃。fullReset 防污染已实现。
