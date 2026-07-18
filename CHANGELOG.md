# Changelog

本项目变更记录。遵循 [Keep a Changelog](https://keepachangelog.com/) 风格。

## [Unreleased] — 系统化安全/正确性硬化 (2026-07-18)

> 分支 `improvements/systematic-review-2026-07`。9 项改进针对代码审查发现的缺口：资源耗尽防护、
> 跨 agent 上下文、注入面、路径校验、运行时卫生、文档漂移。全部遵守仓库宪法（LLM 管内容/代码管流程、
> 传送带原则、一条路径原则、不留遗留代码）。经 9 路对抗式复审揪出并修复 6 个隐藏缺陷 + 1 项 win32 加固。
> **新增 69 个单测全绿，全量回归零回归**（分支与基线的失败文件集完全一致，均为既有平台失败）。

### Security（安全）
- **路径边界校验统一 (A1)**：`before_tool_call` 的 harness 沙箱边界原用朴素 `startsWith` 前缀匹配，
  `"<root>-evil"` 能通过 `"<root>"` 允许根（沙箱逃逸）。收敛到唯一规范 `isPathInsideRoot`
  （`relative()` 正确处理兄弟前缀与 `..`），删除本地重复实现。复审加固：`isPathInsideRoot` 现拒绝
  win32 跨盘符（`C:\` vs `D:\`）的绝对 relation（POSIX 零行为变化）。
- **写入内容字节上限 (A3)**：`before_tool_call` 新增 `1e` 通用守卫，`write`/`edit`/`apply_patch`/
  `multi_edit` 的内容字节数超 `DEFAULT_MAX_WRITE_BYTES`(5MB) 即拦截（防任意大文件落盘）；
  可经 `executionPolicy.maxWriteBytes` 覆盖。
- **累计工具输出字节预算硬停 (A4)**：新增 `HARD_STOP_REASON.OUTPUT_BUDGET_EXHAUSTED`，单会话累计
  工具输出超 `DEFAULT_MAX_OUTPUT_BYTES`(20MB) 即硬停并终态 FAILED（复用既有 hard-stop 链，无新协议）。
- **`[ACTION]` 注入加固 (B7)**：blockquote(`>`) 内、非 `action` 围栏内的标记一律忽略（复读/引用的
  用户内容无法触发特权动作，OWASP LLM01）；新增每会话 nonce 能力令牌（`[ACTION:<nonce>]` /
  JSON `provenance`）。结构化 ` ```action ` 通道在 nonce 未接线前保持惰性，不引入新注入面。

### Added（新增能力）
- **派发跳数 / 扇出 / 环路守卫 (A2)**：新增纯模块 `lib/routing/dispatch-depth-guard.js`——契约携带
  `dispatchDepth` + `originChain` 运行时计数器，在唯一派发 choke point 评估，超 `MAX_DISPATCH_DEPTH`(32)
  或同目标重复超 `MAX_ORIGIN_CHAIN_REPEAT`(6) 即硬停，阻断未声明的 A→B→A 乒乓（各自独立 session、
  循环检测抓不到的场景）。声明的 loop（带 `loopId`）交回 loop-budget 这一唯一权威，不误伤合法长 loop。
- **结构化 / function-calling 双通道 (B7)**：`[ACTION]` 解析器新增 ` ```action ` 围栏 JSON 通道，
  走同一 `normalizeSystemIntent`（能力强的模型可结构化调用；下游 intent 一致，无第二协议）。
- **上游上下文有界注入 + 溢出压缩 (B8)**：新增纯模块 `lib/context-compression.js`——唯一预算真值
  `computeContextBudgetPlan`，跨上游共享字节池（`MAX_UPSTREAM_INBOX_BYTES` 2MB）；溢出文件不整包复制、
  改落 `COMPRESSED_MANIFEST.md`（path+size+截断 head，只读文件头，不整读大文件）；复制/枚举失败落
  可见 `_MISSING.md`（下游读 inbox 即知缺料，不再静默）。

### Changed（变更）
- **工具预算按角色分档 (A5)**：`getDefaultExecutionPolicy(role)` 由「所有角色同值 50」改为冻结
  `ROLE_POLICY` 分档：bridge 15 < reviewer/planner 30 < agent 50 < executor/researcher 80。
  配置的 `executionPolicy.maxToolCalls` 仍覆盖角色默认。
- **`isPathInsideRoot` 成为唯一路径包含真值**：harness 评估器与 `before_tool_call` 现共用同一实现
  （消除此前三份重复/漂移的包含判断）。

### Fixed（修复 · 含对抗复审揪出）
- **A5**：`ROLE_POLICY[normalized]` 对 `constructor`/`__proto__` 等原型成员名会返回 `Object`/
  `Object.prototype` 而非默认策略——改用 `Object.hasOwn` 守卫。
- **A6 事故存储 TTL/LRU**：`execution-incident-store` 纯内存 Map 无 TTL/无上限（长跑只增不减）——新增
  30min 空闲 TTL（基于既有 `updatedAt`）+ 500 条 LRU；删除走单一路径。复审修复：合并路径也把过期
  事故视为不存在，避免新 fault「复活」陈旧 rootFault/createdAt/amplifiers 误标终态诊断。
- **A3**：`collectWriteContent` 原漏了 `apply_patch`(patch/input) 与 `multi_edit`(edits[]) 的载荷字段，
  导致大 patch 绕过大小限制——已覆盖。
- **B8**：`listPackageFiles` 原静默吞 `readdir` 失败（整个包消失、零可观测，比修前 `logger.warn` 更糟）——
  枚举失败现 surface 到 `_MISSING.md`（含「全部不可读」的早返回路径）。

### Docs（文档一致性）
- **角色/花名册对齐 (C9)**：`SYSTEM_MAP.md`/`README.md` 原列了不存在的 `evaluator` 角色、把 agent-id
  `contractor` 当角色、`excutor` 拼写错误——对齐 `AGENT_ROLE`(6 个真实角色) + `openclaw.example.json`
  花名册；新增从 `AGENT_ROLE` 导入的守卫测试锁死文档防再漂移。
- `benchmark.js` 标注 DEPRECATED（与 `test-runner.js` 目的重复，收敛到唯一入口）；`ssh-tunnel.sh` /
  `start.sh` 加隧道策略对账注释。

### Notes（集成点 / 未处理）
- 明确标注的集成点（需 live gateway/build，本次未落地）：B7 的 nonce SOUL 注入、B8 的溢出 LLM 摘要、
  qqbot `.ts` 侧同构双通道。
- 本次范围未含：MCP 工具互操作、OpenTelemetry 可观测对接。
- 平台为 macOS + live openclaw gateway；运行时集成路径以「diff + 单测 + 对抗复审」验证，非 E2E。
