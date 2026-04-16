# CODEX 执行手册（OpenClaw）

本文件给 Codex 用，目标是让每次会话都能稳定接续当前系统，而不是重复摸索。

---

## 1. 角色与边界

- Codex 负责代码实现、排障、测试、文档同步。
- 不改动密钥与敏感配置（`openclaw.json` 仅可读，不外传）。
- 不把流程控制逻辑下放给 LLM 文本指令。
- `harness` 只能作为 agent 执行层套件引入，不得接管平台协作真值。

核心原则：**LLM 产内容，代码控流程。**

`harness` 边界提醒：

- 允许进入：tool execution、sandbox、timeout、artifact/trace、run completion、run-level evaluator input
- 禁止接管：`AgentBinding`、`EdgeSpec`、`LoopSpec`、`ContractSpec`、`MessageEnvelope`、`replyTo / runtimeReturn / deliveryTargets`、automation governance、operator control plane
- 一旦 `harness` 开始决定“谁协作、谁接下一棒、loop 是否继续、结果回给谁”，就说明已经越界，不应继续按执行层实现

---

## 2. 开工前最小检查

```bash
cd ~/.openclaw
git status --short --branch
git log --oneline -n 10
```

然后快速确认：
1. `CLAUDE.md`（规则）
2. `openclaw.json`（当前 agent/插件拓扑）
3. `extensions/watchdog/`（实际实现）

若本轮涉及以下任一对象，禁止直接开写，必须先对照主备忘录：

- `harness`
- `graph / loop / pipeline`
- `contract / envelope`
- `replyTo / runtimeReturn / deliveryTargets`
- `automation / operator` 运行边界

最小必读集：

1. `备忘录61_[主]_Harness接入执行层红线与运行对象_2026-03-23-1226.md`
2. `备忘录62_[主]_Harness与自动化自动化总体指导_2026-03-23-1338.md`
3. `备忘录65_[主]_Loop语义清库与旧研究链路根除_2026-03-24-1418.md`
4. `备忘录66_[主]_代码库清洁指标与运行时真值投影_2026-03-24-1650.md`

若涉及回桥、外部回传或定时任务，再加读：

5. `备忘录60_[主]_定时任务与渠道回传统一设计_2026-03-21-2104.md`

---

## 3. 运行与测试约定

启动：

```bash
bash ~/.openclaw/start.sh
```

测试统一入口（禁止手搓 curl 冒充全链路测试）：

```bash
node ~/.openclaw/extensions/watchdog/test-runner.js --preset single
node ~/.openclaw/extensions/watchdog/test-runner.js --preset concurrent
node ~/.openclaw/extensions/watchdog/test-runner.js --preset loop-basic
```

报告目录：`~/.openclaw/test-reports/`

测试边界补充：

- 测试对象是平台通用能力，不是某个特例 prompt 是否刚好把 agent 推进到目标路径。
- 测试输入默认应像真实用户任务，例如：
  - 简单链路：`你好`、`现在几点`
  - 通用工作任务：`帮我做一下某个卡夫曼算法的优化`
- 允许测试编排操作的平台真值只有：
  - reset / clean
  - graph / edge / loop 登记
  - schedule / automation / operator surface 的显式对象
  - 运行时观测与报告
- 禁止用测试 prompt 直接塞：
  - `请调用 start_pipeline`
  - `startAgent=...`
  - `必须 researcher -> worker-d -> evaluator`
  - `必须输出某个文件`
  - `优先 continue，不要 conclude`
  - 任何只为当前 case 定制的阶段 choreography
- 如果只有靠这种测试专用 prompt 才能跑通，结论应是“平台基础能力不足”或“对象边界没立住”，不是继续补 prompt 或补临时字段。

---

## 4. 备忘录与记忆同步（强制）

Claude 侧已有两套可复用资产：

- 备忘录命令模板：`~/.claude/commands/write-memo.md`
- 项目记忆索引：`~/.claude/projects/-Users-hakens/memory/MEMORY.md`

Codex 执行规则：
1. 发生架构/链路/Agent 配置变更时，必须更新 `~/.openclaw/use guide/` 下主备忘录。
2. 备忘录命名遵循 `备忘录_[主]_{主题}_{YYYY-MM-DD-HHmm}.md`。
3. 已过时文档加 `[过时]` 前缀，不删除。
4. commit/push 前检查本次改动是否需要同步备忘录。

当前 loop 清库以 `备忘录65_[主]_Loop语义清库与旧研究链路根除_2026-03-24-1418.md` 为准。
代码库清洁与死代码清理以 `备忘录66_[主]_代码库清洁指标与运行时真值投影_2026-03-24-1650.md` 为准。
平台测试边界与 loop 修复纪律以 `备忘录67_[主]_平台测试边界与Loop修复执行纪律_2026-03-24-2130.md` 为准。

---

## 5. 提交质量门槛

- 不提交运行垃圾：`test-reports/`、`research-lab/` 下的临时产物、`__pycache__/`（除非任务明确要求）。
- 代码改动必须带最小验证（命令 + 结果结论）。
- 大文件拆分优先，避免新 god object。
- 代码库必须保持干净：禁止保留过时代码、死代码、误导性命名、误导性注释和会制造语义偏差的 UI/样式残留；删除旧语义时必须同步清理实现、样式、文案键、测试和文档。

---

## 6. 常见坑位

- 忘开隧道直接起网关，导致 QQ 链路异常。
- 在 SOUL 里写硬路径逻辑，和 watchdog 实现冲突。
- 把本应属于 runtime / platform 的协作、回桥、loop、automation 决策偷塞进 `harness` 或 skill，造成权限越界。
- 把 `contract` 字段、临时路径、fallback 分支当成语义逃生口，临时补 runtime 真值。
- 把 `contract.output` 这种执行产物指针继续上抬成 loop 推进、harness 保证或平台语义兜底。
- 用测试专用 prompt 编排阶段、文件名、continue/conclude 决策，把“prompt 成功”误当成“平台能力成立”。
- 只看日志不看测试报告，定位效率低。
- 改了系统行为但不更备忘录，导致跨会话断层。

---

## 7. 一句话执行标准

**每次会话都要做到：备忘录先行、对象不越界、代码可运行、链路可验证、文档可接班。**
