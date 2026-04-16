---
name: review-findings
description: 审理发现的结构化标记格式。让 agent 用 [BLOCKING]/[SUGGESTION] 标记写审理结果，平台自动提取。
---

# 审理发现标记

审理产物时，用以下标记格式写发现。平台会自动提取并用于治理决策。

## 标记格式

```
[BLOCKING] 一句话描述问题
- 具体位置或证据
- 置信度: 高/中/低

[SUGGESTION] 一句话描述改进建议
- 具体位置或证据
- 置信度: 高/中/低
```

## 规则

- `[BLOCKING]` = 阻塞性问题，必须修复才能通过
- `[SUGGESTION]` = 改进建议，可以不修
- 每条发现后面跟证据行（用 `-` 开头）
- 置信度标注：`高`（代码里直接看到）、`中`（推测）、`低`（不确定）
- 没有问题就不写标记，不要为了写标记而凑问题

## 示例

```markdown
## 审理发现

[BLOCKING] 密码以明文存储在 localStorage
- src/auth.js 第 23 行：localStorage.setItem("password", pwd)
- 置信度: 高

[SUGGESTION] 错误提示可以更具体
- 当前统一返回 "操作失败"，建议区分 400/401/403
- 置信度: 中
```
