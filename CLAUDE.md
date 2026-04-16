# OpenClaw 项目总纲（2026-03-12）

本文件定义当前项目的硬约束、运行拓扑与维护规范。进入任何开发任务前先读一遍。

--

我们这是一个多agent平台，agent在其中是一个工作单元，平台为他们搭建了一个活动工作空间，所有的agent都在这个空间里面活动与工作，大家使用同一种语言，同一套时钟，同一种模式进行相互工作，通过对agent结构的调整，自动化的实现不同的工作与目标


## 1. 第一原则

**LLM 负责内容，代码负责流程。**

代码硬路径负责：
- 路由（inbox/outbox、delivery）
- 状态机（contract、graph-driven pipeline/loop）
- 调度（传送带 dispatch、排队、唤醒）
- 安全（before_tool_call、敏感信息拦截）
- 质量门控（阈值判定、阶段迁移）

### 传送带原则（Conveyor Belt）

**绝对禁止在 回路 里硬编码 agent 名称或角色特化分支。**

传送带是唯一的 transport 原语：
- Agent 只负责：读 inbox → 处理 → 写 outbox → 停止
- 平台只负责：检查 graph 授权 → 排队 → 目标闲时自动投递 → 唤醒
- Graph edge = 授权（谁能投给谁），不是时序控制
- 目标忙时排队（FIFO），目标闲时自动搬进 inbox
- Loop = 传送带重复投递，不是独立协议
- 结果回传走 replyTo 路由元数据，不走 graph

反模式（绝对禁止）：
- 在 dispatch 逻辑里写 `if (agentId === "xxx")`
- 把相同的功能或事相似的路径翻来覆去造临时流程，最后堆积为相互交错的乱麻
- 为了满足某种特定要求而写的固定完全不可迁移的代码
- 为了实现当前agent拓扑结构能力而编写的以通用外衣伪装的专用代码
- 代码编写简洁且高质量，拒绝重复代码反复复制黏贴

### 代码质量红线

- **不留遗留代码**：废弃的函数、import、变量必须删除，不能注释掉或留 TODO
- **兼容层是临时的**：所有兼容 shim/wrapper 都必须标注生命周期，在下一个稳定 tag 前固化为正式代码并删掉兼容层
- **不为图方便而偷懒**：不使用的代码就是 bug 的温床，必须清理干净，过去的代码会干扰正常工作与计划，更会导致后续维护困难
- **一条路径原则**：必须保证平台真值唯一，只需要一条实现路径即可满足的功能不能随便新创造回路与协议
- **真实可靠**：不能猜测这个系统里面发生了什么，需要调研的文件请详细的列出来文件路径和参考代码行



LLM 软路径负责：
- 任务理解与拆解文本
- 代码/分析产出
- 实验结论解释与自然语言回复

禁止把硬路径职责写进 SOUL 或 task 文本。

---

### 2.2 插件与通道

- 插件：`watchdog`、`qqbot` 启用
- 绑定：`qqbot` 消息绑定到 `agent-for-kksl`
- Gateway：本地 `18789` 端口，token 鉴权


---

## 4. SOUL/HEARTBEAT 规范

每个 SOUL 必须包含：
1. 角色一句话（唯一职责）
2. 明确状态机分支
3. 固定处理步骤（检查 inbox -> 读输入 -> 产出 outbox -> 停止）
4. 输出结构约束
5. 绝对规则（相对路径、禁止越权）

硬规则：
- 只用相对路径（`inbox/`、`outbox/`）
- 不读取 `openclaw.json`
- 完成后立即停止，等待下次唤醒
- HEARTBEAT.md 仅保留一句转发语，不复制 SOUL 内容

---

## 5. 运维与测试

### 5.1 启动

```bash
bash ~/.openclaw/start.sh
```

该脚本会启动 SSH 隧道与 Gateway，并写日志到 `/tmp/openclaw-*.log`。

### 5.2 测试（唯一入口）

```bash
node ~/.openclaw/extensions/watchdog/test-runner.js --preset single
node ~/.openclaw/extensions/watchdog/test-runner.js --preset concurrent
node ~/.openclaw/extensions/watchdog/test-runner.js --preset loop-basic
```

测试规则：
- 禁止手写 curl 冒充链路测试
- 优先看 `test-reports/`，不要先 tail 全量日志

---

## 6. 前端风格（Dashboard）

- 技术栈：原生 HTML/CSS/JS
- 视觉方向：NASA Punk、平面化、信息可读优先
- 禁止重度装饰（大圆角、阴影、毛玻璃、霓虹）

主文件：`extensions/watchdog/dashboard.*` 与 `routes/` 子模块。

---

## 7. 关键目录

- `extensions/watchdog/`：主编排与 API 路由（已模块化）
- `research-lab/`：pipeline / loop 运行时状态目录
- `workspaces/`：各 Agent 工作区（统一存放点）
- `skills/`：运行时可注入技能
- `use guide/`：历史备忘录（含主备忘录）

---

## 8. Git 与安全

- `openclaw.json` 含密钥，严禁外泄
- 提交前先区分“代码变更”和“运行产物”（`research-lab/`、`test-reports/` 等）
- push 常用代理：

```bash
HTTPS_PROXY=http://127.0.0.1:8080 git push
```

---

## 9. 文档维护规则

- 结构调整后必须同步更新本文件
- 版本事实以代码和 `openclaw.json` 为准，不以历史备忘录文字为准
- 任何“行数/体量”描述都必须可由当前代码验证
