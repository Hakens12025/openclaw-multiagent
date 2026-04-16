# Dashboard

> NASA-Punk 美学的前端控制面板，纯 HTML/CSS/vanilla JS，数据驱动 SVG 拓扑。

## 是什么

OpenClaw 系统的可视化控制界面，遵循 NASA-Punk 设计语言：

**技术栈：** 纯 HTML/CSS/vanilla JS，无框架依赖

**设计规则：**
- 平面化 + 至上主义几何
- 字体：微软雅黑（正文）+ Courier New（数据）
- 背景色：#FEF9EC
- **禁止：** border-radius > 4px、box-shadow、渐变按钮、毛玻璃、霓虹光效

**交互能力：**
- 数据驱动 SVG，数据来自 `/watchdog/agents` API
- viewBox 缩放/平移，snap-to-grid 40px，编辑模式切换
- 拖拽、CRUD、缩放
- 受保护 Agent（controller, agent-for-kksl, contractor）不可删除

**Devtools 面板：**
- 隔离测试传输（replyTo.kind = "test_run"）
- 3 个预设测试

**已知问题：**
- Dashboard 有遗留拓扑假设（硬编码 contractor/worker-d/controller）— 显示问题，不影响运行时真值

## 为什么存在

- 多 Agent 系统需要可视化才能有效监控和调试
- 拓扑关系用文本难以理解，SVG 图形直观展示 Agent 间的连接
- 编辑模式允许直接操作 Agent 拓扑（添加/删除/连接）
- Devtools 面板支持快速测试，不需要切到命令行

## 和谁交互

| 概念 | 关系 |
|------|------|
| [System Layering](system-layering.md) | Dashboard 是系统分层中的投影层（Projection Layer） |
| [Building Metaphor](building-metaphor.md) | Dashboard 可视化大楼的拓扑结构 |
| [Test System](test-system.md) | Devtools 面板提供测试注入入口 |

## 演化

1. V3（03-09）：三角拓扑
2. V4（03-09）：多 Worker 垂直指挥塔
3. 03-11：交互式系统（拖拽/CRUD/缩放），dashboard-interactive.js 733 行
4. 后续：Devtools 面板、隔离测试传输
5. 前端测试开发者工具系列迭代

## 当前状态

**功能完整。可交互。** 遗留的硬编码拓扑假设需要清理（显示层问题，不影响运行时）。
