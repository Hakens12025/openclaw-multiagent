---
name: skill-deployer
description: 帮助用户创建并部署新的 openclaw skill。用户描述想要的功能后，AI 起草 SKILL.md，确认部署位置后写入文件。
metadata: {"clawdbot":{"emoji":"🛠️"}}
---

# Skill 部署助手

根据用户描述的需求，起草标准格式的 SKILL.md，并部署到正确位置。

---

## AI 决策指南

| 用户说法 | 意图 | 处置 |
|----------|------|------|
| "帮我创建一个 skill" | 新建 skill | 追问功能描述，起草后询问部署位置 |
| "我想让 AI 能做 xxx" | 新建 skill | 直接起草，询问部署位置 |
| "部署到全局" / "全局可用" | 全局部署 | 写入 `~/.openclaw/skills/<name>/SKILL.md` |
| "部署到 qqbot" / "QQ 插件" | 插件部署 | 写入插件目录并注册到 `openclaw.plugin.json` |

### 何时追问

- 功能描述不够具体时，先问清楚再起草
- 起草完后**必须询问**部署位置（全局 or 插件），不要假设

---

## SKILL.md 标准格式

```markdown
---
name: skill-name           # 小写字母+连字符，唯一标识
description: 一句话说明 AI 在什么情况下应该使用此 skill
metadata: {"clawdbot":{"emoji":"🎯"}}
---

# Skill 标题

一句话介绍这个 skill 的作用。

---

## AI 决策指南

> 本节帮助 AI 快速识别用户意图

| 用户说法 | 意图 | 执行动作 |
|----------|------|----------|
| ... | ... | ... |

### 必须追问的情况
（列出信息缺失时需要追问的项目）

---

## 命令速查

（AI 需要执行的 CLI 命令，带参数说明）

```bash
命令示例
```

---

## 用户交互模板

（AI 回复用户的标准话术）

---

## 使用场景示例

（1-3 个完整的"用户说 → AI 做 → AI 回复"示例）
```

### 格式要点

- `name`：小写+连字符，与目录名一致
- `description`：这是 openclaw 决定是否加载该 skill 的依据，要准确描述触发场景
- **AI 决策指南**：最重要的一节，AI 靠它快速判断该做什么
- **命令速查**：只写 AI 实际要执行的命令，不写用户操作
- 内容要简洁，每节只写必要信息

---

## 部署位置

### 全局 skill（所有 agent 可用）

```bash
# 创建目录并写入文件
mkdir -p ~/.openclaw/skills/<skill-name>
# 写入 SKILL.md 后无需其他操作，openclaw 自动加载
```

适合：与特定 channel 无关的通用功能（工具使用、系统操作、信息查询等）

### 插件 skill（仅绑定该插件的 agent 可用）

```bash
# 创建目录并写入文件
mkdir -p ~/.openclaw/extensions/qqbot/skills/<skill-name>
# 写入 SKILL.md 后还需注册
```

写入后需要编辑 `~/.openclaw/extensions/qqbot/openclaw.plugin.json`，在 `"skills"` 数组中追加：
```json
"skills/qqbot-cron", "skills/qqbot-media", "skills/<skill-name>"
```

适合：依赖 QQ 消息上下文（openid、message_id）或 QQ 专属功能（cron 推送、媒体发送）的 skill

---

## 交互模板

### 起草完成后询问部署位置

```
已起草好 [skill 名称] 的 SKILL.md，内容如下：

[展示 SKILL.md 内容]

---

请问部署到哪里？
- **全局**：所有 agent 都能用（适合通用功能）
- **qqbot 插件**：仅 QQ 对话中的 agent 可用（适合依赖 QQ 上下文的功能）
```

### 全局部署成功

```
已部署到全局：~/.openclaw/skills/[name]/SKILL.md

重启 openclaw 后生效：openclaw gateway run
```

### 插件部署成功

```
已部署到 qqbot 插件：
- 文件：~/.openclaw/extensions/qqbot/skills/[name]/SKILL.md
- 已注册到 openclaw.plugin.json

重启 openclaw 后生效：openclaw gateway run
```
