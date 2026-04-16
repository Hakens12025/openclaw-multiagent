---
name: browser-automation
description: OpenClaw 浏览器自动化工具使用指南。教 AI 如何使用 browser 工具进行网页自动化操作，包括打开网页、截图、点击、输入、获取页面内容等。
metadata: {"clawdbot":{"emoji":"🌐","requires":{"tools":["browser"]}}}
---

# 浏览器自动化 (Browser Automation)

使用 OpenClaw 的 `browser` 工具进行网页自动化操作。这是一个独立的、由 agent 管理的浏览器，与用户的个人浏览器完全隔离。

## 配置说明

当前配置使用 `openclaw` 浏览器配置文件（独立管理的浏览器）。

配置位置：`~/.openclaw/openclaw.json`
```json
{
  "browser": {
    "enabled": true,
    "defaultProfile": "openclaw",
    "headless": false
  }
}
```

## 基本操作

### 1. 启动和停止浏览器

启动浏览器：
```json
{
  "name": "browser",
  "arguments": {
    "action": "start"
  }
}
```

停止浏览器：
```json
{
  "name": "browser",
  "arguments": {
    "action": "stop"
  }
}
```

检查浏览器状态：
```json
{
  "name": "browser",
  "arguments": {
    "action": "status"
  }
}
```

### 2. 打开网页

打开新标签页：
```json
{
  "name": "browser",
  "arguments": {
    "action": "open",
    "url": "https://example.com"
  }
}
```

导航到新 URL（在当前标签页）：
```json
{
  "name": "browser",
  "arguments": {
    "action": "navigate",
    "url": "https://example.com"
  }
}
```

### 3. 管理标签页

列出所有标签页：
```json
{
  "name": "browser",
  "arguments": {
    "action": "tabs"
  }
}
```

聚焦到特定标签页：
```json
{
  "name": "browser",
  "arguments": {
    "action": "focus",
    "target": "tab-id-here"
  }
}
```

关闭标签页：
```json
{
  "name": "browser",
  "arguments": {
    "action": "close",
    "target": "tab-id-here"
  }
}
```

### 4. 获取页面内容

获取页面快照（AI 模式）：
```json
{
  "name": "browser",
  "arguments": {
    "action": "snapshot"
  }
}
```

获取可访问性树快照：
```json
{
  "name": "browser",
  "arguments": {
    "action": "snapshot",
    "mode": "aria"
  }
}
```

截图：
```json
{
  "name": "browser",
  "arguments": {
    "action": "screenshot"
  }
}
```

### 5. 页面交互操作

**点击元素**：
```json
{
  "name": "browser",
  "arguments": {
    "action": "act",
    "operation": "click",
    "ref": 12
  }
}
```

**输入文本**：
```json
{
  "name": "browser",
  "arguments": {
    "action": "act",
    "operation": "type",
    "ref": 12,
    "text": "要输入的文本"
  }
}
```

**按键**：
```json
{
  "name": "browser",
  "arguments": {
    "action": "act",
    "operation": "press",
    "key": "Enter"
  }
}
```

**填写表单**：
```json
{
  "name": "browser",
  "arguments": {
    "action": "act",
    "operation": "fill",
    "ref": 12,
    "value": "表单值"
  }
}
```

**悬停**：
```json
{
  "name": "browser",
  "arguments": {
    "action": "act",
    "operation": "hover",
    "ref": 12
  }
}
```

**选择下拉选项**：
```json
{
  "name": "browser",
  "arguments": {
    "action": "act",
    "operation": "select",
    "ref": 12,
    "value": "选项值"
  }
}
```

**执行 JavaScript**：
```json
{
  "name": "browser",
  "arguments": {
    "action": "act",
    "operation": "evaluate",
    "script": "document.title"
  }
}
```

### 6. 文件上传

上传文件：
```json
{
  "name": "browser",
  "arguments": {
    "action": "upload",
    "files": ["/path/to/file.txt"]
  }
}
```

上传文件并自动点击：
```json
{
  "name": "browser",
  "arguments": {
    "action": "upload",
    "files": ["/path/to/file.txt"],
    "ref": 12
  }
}
```

### 7. 对话框处理

处理浏览器对话框（alert/confirm/prompt）：
```json
{
  "name": "browser",
  "arguments": {
    "action": "dialog",
    "accept": true,
    "text": "对话框输入文本（可选）"
  }
}
```

### 8. 导出 PDF

将页面导出为 PDF：
```json
{
  "name": "browser",
  "arguments": {
    "action": "pdf",
    "path": "/path/to/output.pdf"
  }
}
```

## 典型工作流程

### 工作流 1：搜索和提取信息

1. 启动浏览器
2. 打开搜索引擎
3. 获取页面快照，找到搜索框的 ref
4. 在搜索框中输入查询
5. 按 Enter 键
6. 等待页面加载
7. 获取结果页面快照
8. 提取所需信息

### 工作流 2：填写表单

1. 启动浏览器
2. 打开表单页面
3. 获取页面快照，识别表单字段
4. 依次填写各个字段
5. 点击提交按钮
6. 截图确认提交结果

### 工作流 3：网页监控

1. 启动浏览器
2. 打开目标网页
3. 获取页面快照或截图
4. 提取关键信息
5. 定期重复以监控变化

## 重要提示

1. **ref 参数**：`act` 操作需要 `ref` 参数，这个参数来自 `snapshot` 返回的元素引用（如 `12` 或 `e12`）

2. **等待策略**：避免使用 `wait` 操作，除非确实需要等待特定的 UI 状态

3. **快照优先**：在执行操作前，先使用 `snapshot` 获取页面结构，找到正确的元素 ref

4. **错误处理**：如果操作失败，重新获取快照并尝试找到正确的元素

5. **截图验证**：在关键步骤后使用 `screenshot` 来验证操作是否成功

6. **浏览器配置文件**：
   - `openclaw`：独立管理的浏览器（推荐用于自动化）
   - `chrome`：通过扩展连接到系统浏览器

## 命令行测试

可以使用命令行测试浏览器功能：

```bash
# 启动浏览器
openclaw browser start

# 打开网页
openclaw browser open https://example.com

# 获取快照
openclaw browser snapshot

# 截图
openclaw browser screenshot

# 列出标签页
openclaw browser tabs

# 停止浏览器
openclaw browser stop
```

## 安全注意事项

1. 浏览器操作可能涉及敏感信息，请谨慎处理
2. 不要在浏览器中输入用户的密码或敏感数据，除非用户明确授权
3. 截图可能包含敏感信息，注意保护隐私
4. 自动化操作应遵守目标网站的服务条款

## 限制

1. 某些网站可能有反爬虫机制，可能会阻止自动化访问
2. 需要登录的网站可能需要手动登录或使用 cookie
3. 动态加载的内容可能需要等待或多次快照
4. JavaScript 密集型网站可能需要更复杂的交互策略

## 故障排除

**问题：浏览器无法启动**
- 检查 `browser.enabled` 是否为 `true`
- 检查浏览器可执行文件路径是否正确
- 查看 OpenClaw 日志获取详细错误信息

**问题：找不到元素**
- 重新获取页面快照
- 确认页面已完全加载
- 检查元素是否在可见区域

**问题：操作没有效果**
- 确认使用了正确的 ref
- 检查是否需要先聚焦到正确的标签页
- 尝试使用 `screenshot` 验证当前页面状态

## 相关文档

- OpenClaw 浏览器工具文档：`~/.nvm/versions/node/v25.6.1/lib/node_modules/openclaw/docs/tools/browser.md`
- 配置文件：`~/.openclaw/openclaw.json`
