# CLI System

> 系统正式可操作表面层。不是新的协议族，不持有业务真值。

## 是什么

`CLI system` 统一表示系统的五类正式表面：

- `hook`
- `observe`
- `inspect`
- `apply`
- `verify`

它的职责是把 runtime truth 暴露成稳定入口，供人、operator、automation 读取和操作。

当前第一版统一 registry 已落在：

- [extensions/watchdog/lib/cli-system/cli-surface-registry.js](/Users/hakens/.openclaw/extensions/watchdog/lib/cli-system/cli-surface-registry.js)
- [extensions/watchdog/lib/cli-system/cli-surface-catalog.js](/Users/hakens/.openclaw/extensions/watchdog/lib/cli-system/cli-surface-catalog.js)

## 不是什么

- 不是 `dispatch / system_action / delivery` 的第四条协议族
- 不是新的 runtime truth owner
- 不是 shell 命令集合
- 不是第二控制器

## 和谁交互

- 向下：读取 runtime truth
- 向上：供 [Operator](operator.md) 和后续 automation 使用
- 平行：可投影 [Harness](harness.md) 的结果，但不替代 `HarnessRun`

## 当前状态

- 概念：稳定
- 代码：第一版 registry 已存在
- 待补：schema、更多 surface 家族、统一前端消费
