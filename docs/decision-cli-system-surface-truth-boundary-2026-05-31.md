# 决策：cli-system surface 真值边界裁定（admin = 唯一 apply 真值源）

> 阶段：P2.5（四关节自治计划） | Primary Block：`operator-cli-control` | 日期：2026-05-31
> 性质：真值边界裁定 + 已存在 apply 链路存活证明（调研 + 文档 + 1 个端到端证明，非"从零打通"）

## 0. 纠正一个旧误判

旧结论"operator 手全瘫、apply 一次都执行不了、operatorExecutable 全仓=0"是**错的**——它只 grep 了静态
`cli-surface-catalog.js`，漏看了运行时动态注入的 admin catalog。运行时合并集实测：**28 个
`operatorExecutable:true` 的 apply surface，经 cli-surface-executor 四道门 + operator-executor 已可执行**。
本阶段是**裁定真值边界 + 证明已存在链路活着**，不是从零打通。

## 1. 三源真值流向（实测结论：一源多视图，非真值分裂）

surface 数据有三处"来源/视图"，实测合并后完全自洽：

| 视图 | 文件 | 角色 | apply 数 | operatorExecutable |
|------|------|------|---------|---------------------|
| **static-catalog**（读层声明） | `extensions/watchdog/lib/cli-system/cli-surface-catalog.js` | hook/observe/inspect 的静态读层声明 | **0** | 全 `false`（正确范畴） |
| **admin-catalog**（写层真值） | `extensions/watchdog/lib/admin/admin-surface-catalog.js`（经 `admin-surface-registry.js` 注入） | 真正的写层 surface 源 | **44** | **28 `true`**（全在 apply） |
| **operator-surface-policy**（过滤视图） | `extensions/watchdog/lib/operator/operator-surface-policy.js` | `family==apply && active && operatorExecutable && executable` 的**只读过滤视图** | 视图 | 过滤出正好 **28** |

实测数字（`summarizeAdminSurfaces` / `summarizeCliSystemSurfaces` / `listOperatorExecutableCliSystemSurfaces`）：

- admin counts：`{total:65, inspect:18, apply:44, verify:3, operatorExecutable:28, hold:0, destructive:5}`
- cli-system 合并 counts：`{total:93, operatorExecutable:28, executable:72, byFamily:{hook:2,observe:3,inspect:41,apply:44,verify:3}}`
  - 合并 inspect 41 = static 23 inspect + admin 18 inspect
- operator-policy 可执行 apply：**28**（与 admin operatorExecutable 完全一致）

合并入口：`cli-surface-registry.js:83-92`（`buildCliSystemSurfaceList`）——
`[...staticSurfaces, ...adminSurfaces]`，static 经 `normalizeStaticSurface`、admin 经
`normalizeAdminSurface`（`source:"admin_surface"`）。

**结论：这是"一源多视图"——static 读层 / admin 写层（apply 唯一真值）/ policy 过滤视图——不是多源真值分裂。**
三处数字相互推导、无冲突。

## 2. 裁定

1. **admin-surface 即唯一 apply 真值源**：所有 apply（含 operatorExecutable 判定、handler 即 `executable`）
   都源自 admin catalog。static-catalog 的 0 apply 不是缺陷，而是它本就只是 hook/inspect/observe
   的**读层声明**——其 `operatorExecutable:false` 是**正确范畴**，不应被"翻"成 true。
2. **三层是合理分工，一层都不删**（红线）：static 读层提供 hook/observe/inspect 的稳定声明；
   admin 写层是 apply 真值；policy 是按 family==apply 的只读过滤视图。一源多视图，删任何一层都会破坏
   读层声明或过滤投影。
3. **"否决 applyDecisionAction 旁路"是纯文档性收口**：`grep -rn applyDecisionAction`（全仓除 node_modules）
   = **NOT FOUND**。该函数已不存在，"否决旁路"指向一个已消失的函数，是文档边界宣告，**不是删代码**。

## 3. 分层契约（固化）

```
                 ┌────────────────────────── 真值边界 ──────────────────────────┐
 static-catalog  │  admin-catalog (admin-surface-registry)                      │
 (读层声明)       │  = 唯一 apply 真值源 (44 apply / 28 operatorExecutable:true)  │
 hook/observe/   │                                                              │
 inspect, 0 apply│  operator-surface-policy = family==apply 只读过滤视图          │
                 └──────────────────────────────────────────────────────────────┘
                               │  合并 (cli-surface-registry:83-92)
                               ▼
        cli-surface-executor 四道门（cli-surface-executor.js:19-30）
        ① actor==="operator"  ② operatorExecutable===true
        ③ executable===true   ④ source==="admin_surface"
                               │ 全过
                               ▼
        executeAdminSurfaceOperation（admin-surface-operations.js:317）= apply 执行落点
```

- operator 唯一执行通道：`operator-executor.js:26` → `executeCliSystemSurface` → 四道门 → admin sink。
- inspect/observe/hook **永不**经此 apply 通道（被四道门 ②③④ 挡下），各自有独立读层投影。

## 4. 端到端证明：apply 链路活着

测试：`extensions/watchdog/tests/operator-apply-link-alive.test.js`（3 个用例，全绿）。

- 选 `agents.policy`（operatorExecutable:true / risk=safe / status=active / source=admin_surface）作安全证明对象。
- 用 `--experimental-test-module-mocks` **只 mock apply sink**（`executeAdminSurfaceOperation`），
  保留真实 `hasAdminSurfaceOperationHandler` / `getAdminSurfaceOperationHandler`（registry 仍真算 `executable`）。
  这样**完全不触碰 runtime 真值**（不真改 agent/loop），同时证明四道门对真实
  operatorExecutable:true 的 admin apply surface **放行并真正委派到落点**。
- 断言：四道门前置全满足 + executor 恰好委派一次到 sink + payload 原样透传 + 返回成功结果 +
  真实 sink 导出仍是函数（防证明空转）。

证明结果：**3 pass / 0 fail**。链路活着（不新建 surface、不翻任何 operatorExecutable）。

## 5. 使哪些代码失效（裁定后能力失效清单）

**预期：无 runtime 能力失效。** 本阶段只裁定边界 + 加 1 个证明，未删任何分层。

- static-catalog 读层：**不失效**（hook/observe/inspect 读层声明保留，0 apply / operatorExecutable:false 是正确范畴）。
- operator-surface-policy 过滤视图：**不失效**（family==apply 过滤投影保留）。
- `applyDecisionAction`：**已不存在**（全仓 grep NOT FOUND）→ "否决该旁路"为文档项，无代码可删、无能力失效。

## 6. 红线遵守

- 未翻任何静态 inspect surface 的 operatorExecutable（范畴错误，不碰）。
- 未新建 apply 旁路、未新建 surface。
- 未删 static 读层 / policy 过滤视图（一源多视图，合理分工）。
- 未碰 harness（P0.5 另一 agent）/ automation / 前端 / SKILL.md。
- 文件 UTF-8 无 BOM。

## 7. 引用代码位置

- 合并：`extensions/watchdog/lib/cli-system/cli-surface-registry.js:83-92`
- 四道门：`extensions/watchdog/lib/cli-system/cli-surface-executor.js:19-30`
- apply 落点：`extensions/watchdog/lib/admin/operations/admin-surface-operations.js`（后迁入 operations/ 子目录；当时行锚 :317 已漂移）
- operator 执行通道：`extensions/watchdog/lib/operator/operator-executor.js:26`
- apply 过滤视图：`extensions/watchdog/lib/operator/operator-surface-policy.js`
- admin 写层真值：`extensions/watchdog/lib/admin/admin-surface-registry.js`（`normalizeSurface:197` 用 `hasAdminSurfaceOperationHandler` 算 `executable`）
- static 读层声明：`extensions/watchdog/lib/cli-system/cli-surface-catalog.js`（28 条，0 apply）
- 端到端证明：`extensions/watchdog/tests/operator-apply-link-alive.test.js`
