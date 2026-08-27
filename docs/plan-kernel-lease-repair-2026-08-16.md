# Kernel 租约制度修复计划（RX-01/02/03/04 第一批）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给现行二代 kernel（备忘录57 统一模型的落地骨架）补上两代设计共同缺失的一章——租约制度：副作用有主、注册可撤销、依赖开机断言、配置边界校验。

**Architecture:** 不引入 Cordis、不动通讯协议层（three-layer-protocol 已冻结且健康）、不做大爆炸重写（备忘录42 原则 1 仍有效）。新增 3 个内核小模块（`lease.js` / `config-check.js` / `boot-ledger.js`，各 <100 行），然后用最小 diff 收编三处现存病灶（graveyard intervals、cfg 裸装填、agent-card 幽灵条目）作为试点。推广批（五个二代 registry、tracker 定时器、contract-store 单例）**明确不在本计划内**，见文末清单。

**Tech Stack:** Node 25 ESM、`node:test` + `assert/strict`（仓库现行测试形态，`--test-concurrency=1`）、零外部依赖。

**System Block:** primary = `runtime-core`（RX-01/02/03）；Task 6 = `verification-docs`（支撑位）。

---

## 背景：现状诊断（全部经代码核实，2026-08-16）

| # | 病灶 | 代码证据 |
|---|---|---|
| 1 | 10 个模块级裸可变集合，无主、无清理路径 | `lib/state/state-collections.js:3-12`（sseClients/taskHistory/tracker/dispatchChain/intervalHandles/dispatchTargetStateMap/dispatchOutgoingStateMap/agentCards/runtimeAgentConfigs/ignoredHeartbeatSessions） |
| 2 | interval 句柄只进不出：push 后全仓零次 `clearInterval` | `index.js:377-409`（6 个 setInterval）；`grep -rn clearInterval index.js` 为空 |
| 3 | cfg 裸装填，六个字段无任何类型/范围校验 | `index.js:200-205` 直接逐字段赋值进 `state-collections.js:15-22` 的裸对象 |
| 4 | 依赖隐含在 import 顺序里，缺服务在运行时才炸 undefined | `index.js:1-50` 装配区直接 import ~40 个模块，无声明、无开机断言 |
| 5 | 注册表条目无 owner、无存活谓词 → 幽灵条目（5·29 审计 registry 失效的机理） | `lib/store/agent-card-store.js` 全文：set/delete/get/list/clear 五个函数，条目无任何归属信息 |

设计考古结论（本计划的依据）：一代设计（备忘录40）与二代设计（备忘录57 七个 registry 落点）都只设计了"注册什么"，从未设计"条目生死谁管"。本计划补的就是这一章。

## 理想内核定义（修完后的目标态）

1. **保留不动**：二代 9+1 对象模型、three-layer-protocol 三协议族、thread-tree 正本（v197/198）、`mint-id.js`/`sha256-hex.js` 的单源红线模式。
2. **副作用有主**：任何 setInterval/setTimeout/注册动作在创建处交出撤销凭证，由具名 LeaseHolder 收存；`disposeAll` 逆序执行。`lib/core/lease.js` 是唯一原语（单源红线，同 mint-id 待遇）。
3. **注册表条目带 owner + 存活谓词**：能回答"这条是谁登记的、现在还活着吗"，sweep 可依据谓词清幽灵并记名。
4. **依赖是声明**：gateway_start 收尾处 `bootLedger.assertComplete()`，缺依赖开机报名字（E-BOOT-001），不留到运行时。
5. **配置在边界上 fail-loud**：cfg 装填必经 schema 校验（E-CONFIG-003，并入既有 config 码段），带字段名报错，校验不过插件拒绝加载（注意：宿主捕获 register() 异常后仅跳过本插件、网关照常运行——"拒绝加载"是插件级不是网关级，报错声量靠 logger.error）。
6. **内核入账走唯一落账入口（2026-08-16 用户裁决）**：内核事件需进事件账时（判据：改变了某份在途工作的命运），必须与工作事件同路——`lib/archive/run-event-recorder.js:134` `appendRunEvent()`，payload 约定 `{source:"kernel", reason, kernelRef}`，`causeRefs` 指向被其改变命运的工作事件；**禁止任何旁路写 events.jsonl**。开机期事件（E-BOOT/E-CFG）无 lineage 天然进不了此门——归因判据由 `requireRunLineage` 结构性执行，不靠自觉。内核自身的机房日志（lease/boot/sweep 心跳）另册，不入事件账。

**明确不做**（超出本计划即走偏）：不引入 Cordis/Proxy 上下文/作用域隔离；不做 HMR/热重载（本计划只解锁其前提）；不改 hooks（`before-tool-call.js` 拆分另立计划）；不动 `lib/protocol/`；不动 formal-runtime 逻辑（只在 error-codes.js 注册两个新码）。

---

## Phase 0：开工纪律

- [ ] **Step 0.1: 声明 primary block**

```bash
cd ~/.openclaw && node scripts/openclaw-block-check.js --primary runtime-core
```

Expected: 通过（无跨块警报）。

- [ ] **Step 0.2: 基线测试**

```bash
cd ~/.openclaw/extensions/watchdog && npm test 2>&1 | tail -5
```

Expected: `pass 1588`（或 1587/1，失败⊆已知 flaky 集即安全——见 MEMORY「测试门有 flaky 群」）。记下基线数字。

---

## Task 1: 租约原语 `lib/core/lease.js`

**Files:**
- Create: `~/.openclaw/extensions/watchdog/lib/core/lease.js`
- Test: `~/.openclaw/extensions/watchdog/tests/core-lease.test.js`

- [ ] **Step 1.1: 写失败测试**

```js
// tests/core-lease.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { createLeaseHolder } from "../lib/core/lease.js";

test("effect 返回单次生效的撤销凭证", () => {
  const lease = createLeaseHolder("t");
  let calls = 0;
  const dispose = lease.effect(() => { calls++; }, "x");
  assert.equal(dispose(), true);
  assert.equal(dispose(), false);
  assert.equal(calls, 1);
  assert.equal(lease.size(), 0);
});

test("disposeAll 逆序执行且二次调用为空操作", () => {
  const lease = createLeaseHolder("t");
  const order = [];
  lease.effect(() => order.push("a"), "a");
  lease.effect(() => order.push("b"), "b");
  lease.effect(() => order.push("c"), "c");
  assert.equal(lease.disposeAll(), 3);
  assert.deepEqual(order, ["c", "b", "a"]);
  assert.equal(lease.disposeAll(), 0);
});

test("disposeAll 单条失败不阻断其余，逐条上报", () => {
  const lease = createLeaseHolder("t");
  const order = [];
  const errors = [];
  lease.effect(() => order.push("a"), "a");
  lease.effect(() => { throw new Error("boom"); }, "bad");
  lease.effect(() => order.push("c"), "c");
  assert.equal(lease.disposeAll((e, label) => errors.push(label)), 2);
  assert.deepEqual(order, ["c", "a"]);
  assert.deepEqual(errors, ["bad"]);
});

test("disposeAll 之后 effect 抛错（防清理期逃逸）", () => {
  const lease = createLeaseHolder("t");
  lease.disposeAll();
  assert.throws(() => lease.effect(() => {}), /after disposeAll/);
});

test("interval 凭证可清定时器", () => {
  const lease = createLeaseHolder("t");
  const dispose = lease.interval(() => {}, 60_000, "tick");
  assert.equal(lease.size(), 1);
  assert.equal(dispose(), true);
  assert.equal(lease.size(), 0);
});

test("owner 缺失或 disposer 非函数即抛（fail-loud）", () => {
  assert.throws(() => createLeaseHolder(""), /owner name required/);
  const lease = createLeaseHolder("t");
  assert.throws(() => lease.effect(null, "x"), /must be a function/);
});

test("高频登记-撤销后账本自压缩,不留尸体（防以泄漏形态修泄漏）", () => {
  const lease = createLeaseHolder("t");
  for (let i = 0; i < 1000; i++) {
    const dispose = lease.effect(() => {}, `churn-${i}`);
    dispose();
  }
  assert.equal(lease.size(), 0);
  assert.equal(lease.ledgerSize(), 0); // 内部账本也为空——推广批 tracker 高频定时器换手的前提
});

test("异步 disposer 拒收:thenable 走 onError 不计成功（同步专属是结构性约束）", () => {
  const lease = createLeaseHolder("t");
  const errors = [];
  lease.effect(async () => {}, "async-bad");
  assert.equal(lease.disposeAll((e, label) => errors.push(label)), 0);
  assert.deepEqual(errors, ["async-bad"]);
});
```

- [ ] **Step 1.2: 跑测试确认失败**

```bash
cd ~/.openclaw/extensions/watchdog && node --test tests/core-lease.test.js
```

Expected: FAIL，`Cannot find module '.../lib/core/lease.js'`。

- [ ] **Step 1.3: 实现**

```js
// lib/core/lease.js — 进程内副作用租约（RX-01 单一原语，单源红线同 mint-id 待遇）。
// 语义：effect() 登记撤销凭证并返回其单次生效包装；disposeAll() 逆序执行，
// 单条失败不阻断其余（逐条上报 onError），二次调用为空操作；
// disposeAll 之后禁止再登记（防清理期注册逃逸——Cordis fiber 加固第 6 条同款教训）。
// 账本自压缩：撤销即从账本移除，高频登记-撤销不留尸体（否则是以泄漏形态修泄漏）。
// 同步专属：disposer 返回 thenable 一律按错误处理——异步清理需要 await 语义，
// 那是推广批的原语升级项（收编 run-event-recorder 这类 async close 之前必须先升级），
// 升级前结构性拒收，不靠自觉。
export function createLeaseHolder(owner) {
  const ownerName = typeof owner === "string" && owner.trim() ? owner.trim() : null;
  if (!ownerName) throw new Error("[lease] owner name required");
  const entries = new Set();
  let disposedAll = false;

  function isThenable(value) {
    return value != null && typeof value.then === "function";
  }

  function runDisposer(entry) {
    const result = entry.dispose();
    if (isThenable(result)) {
      result.catch(() => {}); // 防 unhandledRejection;该结果本身按错误处理
      throw new Error(`[lease:${ownerName}] async disposer not supported (label=${entry.label}); upgrade the primitive before enrolling async cleanup`);
    }
  }

  function effect(dispose, label = "") {
    if (disposedAll) throw new Error(`[lease:${ownerName}] effect() after disposeAll()`);
    if (typeof dispose !== "function") {
      throw new Error(`[lease:${ownerName}] disposer must be a function (label=${label})`);
    }
    const entry = { label: String(label || ""), dispose };
    entries.add(entry);
    return function disposeOnce() {
      if (!entries.has(entry)) return false;
      entries.delete(entry);
      runDisposer(entry);
      return true;
    };
  }

  function interval(fn, ms, label = "") {
    const handle = setInterval(fn, ms);
    return effect(() => clearInterval(handle), label || `interval:${ms}ms`);
  }

  function size() {
    return entries.size;
  }

  function ledgerSize() {
    return entries.size; // 账本即活口:撤销条目已移除,无 done 尸体可数
  }

  function disposeAll(onError) {
    if (disposedAll) return 0;
    disposedAll = true;
    let disposedCount = 0;
    for (const entry of [...entries].reverse()) {
      entries.delete(entry);
      try {
        runDisposer(entry);
        disposedCount++;
      } catch (error) {
        if (typeof onError === "function") onError(error, entry.label);
      }
    }
    return disposedCount;
  }

  return Object.freeze({ owner: ownerName, effect, interval, size, ledgerSize, disposeAll });
}
```

- [ ] **Step 1.4: 跑测试确认通过**

```bash
node --test tests/core-lease.test.js
```

Expected: 8 pass。

- [ ] **Step 1.5: Commit（注意共用工作区路径限定纪律）**

```bash
cd ~/.openclaw && git add extensions/watchdog/lib/core/lease.js extensions/watchdog/tests/core-lease.test.js && git commit -m "feat(runtime-core): lease primitive — 副作用租约原语(RX-01)

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>" -- extensions/watchdog/lib/core/lease.js extensions/watchdog/tests/core-lease.test.js
```

---

## Task 2: 收编 graveyard intervals（`index.js:377-409`）

**Files:**
- Create: `~/.openclaw/extensions/watchdog/lib/core/kernel-lease.js`（单例锚，与 boot-ledger 同款模式）
- Modify: `~/.openclaw/extensions/watchdog/index.js`（import 区、377 行 push 块、gateway_stop 接线）
- Modify: `~/.openclaw/extensions/watchdog/lib/state/state-collections.js:7`（删除 intervalHandles）

前置事实（已核实）：`intervalHandles` 全仓仅 3 处出现——定义 `state-collections.js:7`、import `index.js:9`、push `index.js:377`。**没有任何读取或清理者**，删除安全。

- [ ] **Step 2.1: 创建 kernel 租约单例锚 + 接入 gateway_stop**

新建 `lib/core/kernel-lease.js`（**不放 index.js**：入口锚会逼测试求值整张 45-import 装配图，且推广批 tracker-store 反向 import 会成环；与 bootLedger 同款 lib/core 锚法）：

```js
// lib/core/kernel-lease.js — kernel 租约单例锚（与 boot-ledger.js 同款模式）。
// 本插件一切进程内副作用的属主;各 lib 模块直接 import 本模块取租约,
// 不经 index.js(防装配图求值与循环依赖)。
import { createLeaseHolder } from "./lease.js";

export const kernelLease = createLeaseHolder("watchdog-kernel");
```

`index.js` import 区加 `import { kernelLease } from "./lib/core/kernel-lease.js";`，并在 register() 内其他 `api.on(...)` 旁接入停机清扫（**宿主有 gateway_stop**：plugin-sdk `types.d.ts:262` PluginHookName 含 `"gateway_stop"`，SIGTERM/SIGINT → `runGatewayStop` 触发链完整——watchdog 此前从未用过此事件，首次接线，收尾 V.2 重启网关时观察日志实证一次）：

```js
    api.on("gateway_stop", () => {
      const n = kernelLease.disposeAll((e, label) => logger?.warn?.(`[lease] dispose ${label}: ${e?.message || e}`));
      logger?.info?.(`[watchdog] gateway_stop: kernelLease disposed ${n} effect(s)`);
    });
```

（不接这一步，kernelLease 就是把 intervalHandles 的"登记但永不清理"抬高一层重演——审计原话。）

- [ ] **Step 2.2: 改写 push 块（回调体逐字不动）**

`index.js:377` 的 `intervalHandles.push(` 改为 `const maintenanceHandles = [`；**与它配对的收尾 `);`**（第 6 个 setInterval 回调结束后的那一个——用括号配对确认，不要凭行号猜；改完以 `node --check` 验证）改为：

```js
      ];
      for (const handle of maintenanceHandles) {
        kernelLease.effect(() => clearInterval(handle), "maintenance-interval");
      }
```

6 个 `setInterval(...)` 实参列表逐字保留（数组字面量与 push 实参同为逗号分隔，中间不需要任何改动）。

- [ ] **Step 2.3: 删除 intervalHandles**

- `lib/state/state-collections.js:7` 删除 `export const intervalHandles = [];`
- `index.js:9` 从 import 列表删除 `intervalHandles,`

- [ ] **Step 2.4: 语法与残留检查**

```bash
cd ~/.openclaw/extensions/watchdog && node --check index.js && grep -rn "intervalHandles" --include="*.js" . | grep -v node_modules; echo "exit=$?"
```

Expected: `node --check` 无输出；grep 无命中（exit=1）。

- [ ] **Step 2.5: 全量测试**

```bash
npm test 2>&1 | tail -5
```

Expected: 与 Phase 0 基线一致（失败⊆flaky 集）。

- [ ] **Step 2.6: Commit**

```bash
cd ~/.openclaw && git add extensions/watchdog/lib/core/kernel-lease.js extensions/watchdog/index.js extensions/watchdog/lib/state/state-collections.js && git commit -m "refactor(runtime-core): maintenance intervals 入租约+gateway_stop 清扫,删除只写坟场 intervalHandles(RX-01)

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>" -- extensions/watchdog/lib/core/kernel-lease.js extensions/watchdog/index.js extensions/watchdog/lib/state/state-collections.js
```

---

## Task 3: cfg 边界校验（RX-03）

**Files:**
- Create: `~/.openclaw/extensions/watchdog/lib/core/config-check.js`
- Modify: `~/.openclaw/extensions/watchdog/index.js:200-205`
- Modify: `~/.openclaw/extensions/watchdog/lib/formal-runtime/error-codes.js`（注册 E-CFG-001）
- Test: `~/.openclaw/extensions/watchdog/tests/core-config-check.test.js`

- [ ] **Step 3.1: 写失败测试**

```js
// tests/core-config-check.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { validateCfgAssignment } from "../lib/core/config-check.js";

const GOOD = Object.freeze({
  hooksToken: "", qqAppId: "", qqClientSecret: "",
  gatewayPort: 18789, gatewayToken: "tok", agentTimeout: 1800000,
});

test("合法配置原样通过（空字符串合法——是否必填是部署策略,不是类型问题）", () => {
  assert.deepEqual(validateCfgAssignment({ ...GOOD }), GOOD);
});

test("端口越界即抛,报错带字段名", () => {
  assert.throws(() => validateCfgAssignment({ ...GOOD, gatewayPort: 0 }), /E-CONFIG-003[\s\S]*gatewayPort/);
  assert.throws(() => validateCfgAssignment({ ...GOOD, gatewayPort: 70000 }), /gatewayPort/);
});

test("agentTimeout 非正整数即抛", () => {
  assert.throws(() => validateCfgAssignment({ ...GOOD, agentTimeout: -1 }), /agentTimeout/);
  assert.throws(() => validateCfgAssignment({ ...GOOD, agentTimeout: 1.5 }), /agentTimeout/);
});

test("类型错误即抛", () => {
  assert.throws(() => validateCfgAssignment({ ...GOOD, hooksToken: 123 }), /hooksToken/);
});

test("未知键即抛（防拼写错的配置静默失效）", () => {
  assert.throws(() => validateCfgAssignment({ ...GOOD, gatewyToken: "x" }), /unknown keys[\s\S]*gatewyToken/);
});

test("多个错误一次全报", () => {
  try {
    validateCfgAssignment({ ...GOOD, gatewayPort: 0, agentTimeout: -1 });
    assert.fail("should throw");
  } catch (error) {
    assert.match(error.message, /gatewayPort/);
    assert.match(error.message, /agentTimeout/);
  }
});
```

- [ ] **Step 3.2: 跑测试确认失败**

```bash
node --test tests/core-config-check.test.js
```

Expected: FAIL，模块不存在。

- [ ] **Step 3.3: 实现**

```js
// lib/core/config-check.js — cfg 边界校验（RX-03）。校验不过即抛,插件拒绝带病加载。
// 只校验类型与范围;空字符串合法(是否必填是部署策略,不在类型层裁决)。
const CFG_RULES = Object.freeze({
  hooksToken: "string",
  qqAppId: "string",
  qqClientSecret: "string",
  gatewayToken: "string",
  gatewayPort: "port",
  agentTimeout: "positiveInt",
});

export function validateCfgAssignment(candidate) {
  const errors = [];
  for (const [key, rule] of Object.entries(CFG_RULES)) {
    const value = candidate[key];
    if (rule === "string" && typeof value !== "string") {
      errors.push(`${key}: expected string, got ${typeof value}`);
    } else if (rule === "port" && (!Number.isInteger(value) || value < 1 || value > 65535)) {
      errors.push(`${key}: expected integer port 1-65535, got ${JSON.stringify(value)}`);
    } else if (rule === "positiveInt" && (!Number.isInteger(value) || value <= 0)) {
      errors.push(`${key}: expected positive integer (ms), got ${JSON.stringify(value)}`);
    }
  }
  const unknown = Object.keys(candidate).filter((k) => !(k in CFG_RULES));
  if (unknown.length) errors.push(`unknown keys: ${unknown.join(", ")}`);
  if (errors.length) {
    throw new Error(`[E-CONFIG-003] watchdog cfg invalid:\n${errors.map((e) => `  - ${e}`).join("\n")}`);
  }
  return candidate;
}
```

- [ ] **Step 3.4: 跑测试确认通过**

```bash
node --test tests/core-config-check.test.js
```

Expected: 6 pass。

- [ ] **Step 3.5: 接线到装填点**

`index.js:200-205` 现状：

```js
    cfg.qqAppId = config?.channels?.qqbot?.appId || "";
    cfg.qqClientSecret = config?.channels?.qqbot?.clientSecret || "";
    cfg.hooksToken = config?.hooks?.token || "";
    cfg.gatewayPort = config?.gateway?.port || 18789;
    cfg.gatewayToken = config?.gateway?.auth?.token ?? "";
    cfg.agentTimeout = (config?.agents?.defaults?.timeoutSeconds || 1800) * 1000;
```

替换为：

```js
    Object.assign(cfg, validateCfgAssignment({
      qqAppId: config?.channels?.qqbot?.appId || "",
      qqClientSecret: config?.channels?.qqbot?.clientSecret || "",
      hooksToken: config?.hooks?.token || "",
      gatewayPort: config?.gateway?.port || 18789,
      gatewayToken: config?.gateway?.auth?.token ?? "",
      agentTimeout: (config?.agents?.defaults?.timeoutSeconds || 1800) * 1000,
    }));
```

并在 import 区加 `import { validateCfgAssignment } from "./lib/core/config-check.js";`。

- [ ] **Step 3.6: 注册 E-CONFIG-003（并入既有 config 段，不新开 E-CFG 前缀）**

`error-codes.js:159` 已有 `config` 段（E-CONFIG-001/002，语义"平台配置文件本身"）——watchdog cfg 派生自 openclaw.json 的值，语义同段；另开 `E-CFG-*` 前缀会造成近同名双前缀并存。在该段 E-CONFIG-002 之后追加：

```js
  "E-CONFIG-003": entry("config", "watchdog plugin cfg failed boundary validation at register() (values derived from openclaw.json)", "field list is in the thrown message; fix the value in openclaw.json — validation is types/ranges only, empty strings are legal"),
```

- [ ] **Step 3.7: 全量测试 + commit**

```bash
cd ~/.openclaw/extensions/watchdog && node --check index.js && npm test 2>&1 | tail -5
cd ~/.openclaw && git add extensions/watchdog/lib/core/config-check.js extensions/watchdog/tests/core-config-check.test.js extensions/watchdog/index.js extensions/watchdog/lib/formal-runtime/error-codes.js && git commit -m "feat(runtime-core): cfg 边界校验 fail-loud(RX-03, E-CONFIG-003)

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>" -- extensions/watchdog/lib/core/config-check.js extensions/watchdog/tests/core-config-check.test.js extensions/watchdog/index.js extensions/watchdog/lib/formal-runtime/error-codes.js
```

注意：改了 formal-runtime 文件——**若要跑 formal suite 需重启网关**（suite 在网关进程内）；unit 测试不受影响。本 task 验证以 unit + npm test 为准，网关重启留到收尾统一做。

---

## Task 4: 开机依赖账本（RX-02）

**Files:**
- Create: `~/.openclaw/extensions/watchdog/lib/core/boot-ledger.js`
- Modify: `~/.openclaw/extensions/watchdog/index.js`（gateway_start 收尾，:426 `FULLY INITIALIZED` 日志行之前）
- Modify: `~/.openclaw/extensions/watchdog/lib/formal-runtime/error-codes.js`（注册 E-BOOT-001）
- Test: `~/.openclaw/extensions/watchdog/tests/core-boot-ledger.test.js`

- [ ] **Step 4.1: 写失败测试**

```js
// tests/core-boot-ledger.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { createBootLedger } from "../lib/core/boot-ledger.js";

test("依赖齐备时 assertComplete 通过并给出计数", () => {
  const ledger = createBootLedger();
  ledger.provide("store.tracker", "state-collections");
  ledger.requires("store.tracker", "lifecycle/agent-timeout-sweep");
  const summary = ledger.assertComplete();
  assert.equal(summary.providedCount, 1);
  assert.equal(summary.requiredCount, 1);
});

test("缺依赖即抛,报错点名缺什么、谁在要", () => {
  const ledger = createBootLedger();
  ledger.requires("store.contracts", "routing/dispatch");
  assert.throws(() => ledger.assertComplete(), /E-BOOT-001[\s\S]*store\.contracts[\s\S]*routing\/dispatch/);
});

test("断言之后禁止再声明（防装配期之后的漂移）", () => {
  const ledger = createBootLedger();
  ledger.assertComplete();
  assert.throws(() => ledger.provide("x", "y"), /after assertComplete/);
  assert.throws(() => ledger.requires("x", "y"), /after assertComplete/);
});

test("重复 provide 同名即抛（一条路径原则:双供给=真值分裂前兆）", () => {
  const ledger = createBootLedger();
  ledger.provide("store.tracker", "a");
  assert.throws(() => ledger.provide("store.tracker", "b"), /already provided/);
});

test("summary 报告封账状态与计数（health 体检的消费面,无副作用可重复读）", () => {
  const ledger = createBootLedger();
  ledger.provide("a", "p");
  assert.deepEqual(ledger.summary(), { sealed: false, providedCount: 1, requiredCount: 0 });
  ledger.assertComplete();
  assert.equal(ledger.summary().sealed, true);
  assert.equal(ledger.summary().sealed, true); // 二次读无副作用
});
```

- [ ] **Step 4.2: 跑测试确认失败**

```bash
node --test tests/core-boot-ledger.test.js
```

Expected: FAIL，模块不存在。

- [ ] **Step 4.3: 实现**

```js
// lib/core/boot-ledger.js — 开机依赖账本（RX-02）。
// 装配期各模块声明 provide/requires,gateway_start 收尾 assertComplete:
// 缺依赖开机点名报错,不留到运行时炸 undefined。
// bootLedger 是内核有意保留的唯一单例锚（与 state.js cfg 同级）;测试用 createBootLedger()。
export function createBootLedger() {
  const provided = new Map(); // name → provider
  const required = new Map(); // name → Set<requester>
  let sealed = false;

  function guard(op) {
    if (sealed) throw new Error(`[boot-ledger] ${op} after assertComplete()`);
  }

  function provide(name, provider = "unknown") {
    guard("provide()");
    if (provided.has(name)) {
      throw new Error(`[boot-ledger] "${name}" already provided by ${provided.get(name)}`);
    }
    provided.set(name, provider);
  }

  function requires(name, requester = "unknown") {
    guard("requires()");
    if (!required.has(name)) required.set(name, new Set());
    required.get(name).add(requester);
  }

  function assertComplete() {
    sealed = true;
    const missing = [...required.entries()].filter(([name]) => !provided.has(name));
    if (missing.length) {
      const lines = missing.map(([name, who]) => `  - ${name} (required by: ${[...who].join(", ")})`);
      throw new Error(`[E-BOOT-001] boot deps missing:\n${lines.join("\n")}`);
    }
    return { providedCount: provided.size, requiredCount: required.size };
  }

  function summary() {
    // 无副作用只读面:health 体检与 runtime state 路由消费,封账前后均可重复调用
    return { sealed, providedCount: provided.size, requiredCount: required.size };
  }

  return Object.freeze({ provide, requires, assertComplete, summary });
}

export const bootLedger = createBootLedger();
```

- [ ] **Step 4.4: 跑测试确认通过**

```bash
node --test tests/core-boot-ledger.test.js
```

Expected: 5 pass。

- [ ] **Step 4.5: 接线（首批声明种子）**

`index.js` import 区加 `import { bootLedger } from "./lib/core/boot-ledger.js";`。gateway_start 收尾、`:426` 的 `logger.info("[watchdog] ===== WATCHDOG V3 MODULAR FULLY INITIALIZED =====")` 之前插入：

```js
      // RX-02 首批声明种子:先集中在装配点,推广批再下放到各属主模块。
      bootLedger.provide("store.tracker", "state-collections");
      bootLedger.provide("store.agent-cards", "agent-card-store");
      bootLedger.provide("store.contracts", "contract-store");
      bootLedger.provide("agent.identity", "agent-identity");
      bootLedger.requires("store.tracker", "lifecycle/agent-timeout-sweep");
      bootLedger.requires("store.contracts", "routing/dispatch");
      bootLedger.requires("agent.identity", "routing/dispatch");
      try {
        const bootSummary = bootLedger.assertComplete();
        logger.info(`[watchdog] boot deps ok: provided=${bootSummary.providedCount} required=${bootSummary.requiredCount}`);
      } catch (error) {
        // 宿主 hook-runner 以 catchErrors:true 吞 handler 异常(runVoidHook→handleHookError 只剩一行日志),
        // 裸 throw 是哑炮——fail-loud 必须自己造响:error 级日志 + SSE alert(broadcast 已在 index.js 导入)。
        logger.error(String(error?.message || error));
        broadcast("alert", { type: "boot_deps_missing", message: String(error?.message || error) });
      }
```

> **裁决点（用户）**：缺依赖时是否升级为 `process.exit(1)`（网关拒绝带残启动）——属破坏性策略。本计划默认只报不杀（error 日志 + alert + health 红），要杀需用户点头后在 catch 内追加一行。

- [ ] **Step 4.6: 注册 E-BOOT-001（自带新段，与 Task 3 解耦——单独 revert 互不牵连）**

`lib/formal-runtime/error-codes.js` 的 `ERROR_CODES` 表内新增独立段：

```js
  // ── kernel / boot（进程内装配期,区别于 config 段的配置文件形状）──────────────
  "E-BOOT-001": entry("kernel", "boot dependency ledger found required service without provider", "missing names and requesters are in the thrown message; add the matching bootLedger.provide() at the owning module's wiring in index.js gateway_start"),
```

- [ ] **Step 4.7: health 体检覆盖（零 LLM，~15 行）——boot 账本从第一天被机器体检，不靠人翻日志**

先定位 health suite 驱动与其 CheckResult 构造惯例：

```bash
grep -rln "health" ~/.openclaw/extensions/watchdog/lib/formal-runtime/checks/ | head -3
```

在 health suite 内按其**现有 add/CheckResult 形态**（逐字对齐，勿新造形状；suite 跑在网关进程内，直接 import 单例即读真实封账状态）登记一条下界断言：

```js
import { bootLedger } from "../../core/boot-ledger.js"; // 相对层级按 checks 实际目录调整

// boot 依赖账本:已封账且 provide 计数不低于当前接线下界(4);fail 码 E-BOOT-001。
// 下界断言(>=4 而非 ===4):接线增加不红,符合 health 计数惯例。
const bootDeps = bootLedger.summary();
// bootDeps.sealed !== true || bootDeps.providedCount < 4 → fail(E-BOOT-001, 详情带 sealed/counts)
// 否则 → pass(`boot deps sealed, provided=${bootDeps.providedCount}`)
```

（此步是全计划唯一需要执行者现场对齐 API 形状的点——health suite 内部构造我们未预读；断言语义与成本已经审计确认可行。）

- [ ] **Step 4.8: 全量测试 + commit**

```bash
cd ~/.openclaw/extensions/watchdog && node --check index.js && npm test 2>&1 | tail -5
cd ~/.openclaw && git add extensions/watchdog/lib/core/boot-ledger.js extensions/watchdog/tests/core-boot-ledger.test.js extensions/watchdog/index.js extensions/watchdog/lib/formal-runtime/error-codes.js extensions/watchdog/lib/formal-runtime/checks/ && git commit -m "feat(runtime-core): 开机依赖账本 fail-loud+health 覆盖(RX-02, E-BOOT-001)

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>" -- extensions/watchdog/lib/core/boot-ledger.js extensions/watchdog/tests/core-boot-ledger.test.js extensions/watchdog/index.js extensions/watchdog/lib/formal-runtime/error-codes.js extensions/watchdog/lib/formal-runtime/checks/
```

---

## Task 5: 试点注册表租约化 — `agent-card-store`（RX-01 首店）

**Files:**
- Modify: `~/.openclaw/extensions/watchdog/lib/store/agent-card-store.js`（全文重写，现仅 23 行）
- Modify: `~/.openclaw/extensions/watchdog/index.js`（gateway_start：sweep 接线）
- Test: `~/.openclaw/extensions/watchdog/tests/store-agent-card-lease.test.js`

选它试点的理由：最小（5 个导出）、有真实病史（5·29 审计幽灵引用的样本类别）、消费者经 grep 核实共 5 文件（写侧：`index.js` loadAgentCards、`lib/agent/admin/agent-admin-create-delete.js:221`、`lib/agent/admin/agent-admin-profile.js:235,325`；读侧：`agent-identity.js`、`runtime-mailbox-handler-registry.js`），返回值均被忽略 → 签名向后兼容。仓内已有两处 sweep 惯例可对齐（`lib/runtime/execution-incident-store.js:105`、`lib/lifecycle/agent-timeout-sweep.js:72`），本试点不是首创。

- [ ] **Step 5.1: 写失败测试**

```js
// tests/store-agent-card-lease.test.js
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  setAgentCard, getAgentCard, getAgentCardMeta, sweepAgentCards, clearAgentCards,
} from "../lib/store/agent-card-store.js";

beforeEach(() => clearAgentCards());

test("注册返回撤销凭证,条目带 owner 元数据", () => {
  const dispose = setAgentCard("a1", { name: "A1" }, "test-owner");
  assert.equal(getAgentCard("a1").name, "A1");
  assert.equal(getAgentCardMeta("a1").owner, "test-owner");
  assert.equal(dispose(), true);
  assert.equal(getAgentCard("a1"), null);
  assert.equal(getAgentCardMeta("a1"), null);
  assert.equal(dispose(), false); // 单次生效
});

test("sweep 依存活谓词清幽灵并记名（graceMs=0 关宽限）", () => {
  setAgentCard("alive", {}, "reg");
  setAgentCard("ghost", {}, "reg");
  const swept = sweepAgentCards((id) => id === "alive", { graceMs: 0 });
  assert.deepEqual(swept.map((s) => s.agentId), ["ghost"]);
  assert.equal(swept[0].owner, "reg");
  assert.notEqual(getAgentCard("alive"), null);
  assert.equal(getAgentCard("ghost"), null);
});

test("宽限期内的新条目不清（在途窗口保护:admin create 先卡后配）", () => {
  setAgentCard("fresh", {}, "reg");
  const swept = sweepAgentCards(() => false, { graceMs: 60_000 });
  assert.equal(swept.length, 0);
  assert.notEqual(getAgentCard("fresh"), null);
});

test("dryRun 只报告不删除（soak 观察模式）", () => {
  setAgentCard("ghost", {}, "reg");
  const swept = sweepAgentCards(() => false, { graceMs: 0, dryRun: true });
  assert.equal(swept.length, 1);
  assert.notEqual(getAgentCard("ghost"), null); // 仍在
});

test("owner 缺省为 unknown（兼容旧调用方）", () => {
  setAgentCard("legacy", {});
  assert.equal(getAgentCardMeta("legacy").owner, "unknown");
});
```

- [ ] **Step 5.2: 跑测试确认失败**

```bash
node --test tests/store-agent-card-lease.test.js
```

Expected: FAIL，`getAgentCardMeta`/`sweepAgentCards` 未导出。

- [ ] **Step 5.3: 全文重写 store**

```js
// lib/store/agent-card-store.js — agentCards 租约化试点（RX-01 首店）:
// 条目带 owner 元数据,注册返回单次生效的撤销凭证,sweep 依存活谓词清幽灵并记名。
// （5·29 审计「registry 失效/幽灵引用」的对症修法;推广批以本文件为模板。）
import { agentCards } from "../state/state-collections.js";

const cardMeta = new Map(); // agentId → { owner, registeredAt }

export function setAgentCard(agentId, card, owner = "unknown") {
  agentCards.set(agentId, card);
  cardMeta.set(agentId, { owner, registeredAt: Date.now() });
  let disposed = false;
  return function disposeAgentCard() {
    if (disposed) return false;
    disposed = true;
    agentCards.delete(agentId);
    cardMeta.delete(agentId);
    return true;
  };
}

export function deleteAgentCard(agentId) {
  cardMeta.delete(agentId);
  return agentCards.delete(agentId);
}

export function getAgentCard(agentId) {
  return agentCards.get(agentId) || null;
}

export function getAgentCardMeta(agentId) {
  return cardMeta.get(agentId) || null;
}

export function listAgentCards() {
  return [...agentCards.entries()];
}

export function clearAgentCards() {
  agentCards.clear();
  cardMeta.clear();
}

export function sweepAgentCards(isAlive, { logger, graceMs = 60_000, dryRun = false } = {}) {
  const now = Date.now();
  const swept = [];
  for (const agentId of [...agentCards.keys()]) {
    const meta = cardMeta.get(agentId);
    // 在途宽限:admin create 先 setAgentCard(:221)后 saveConfig(:228),新卡不判死;
    // profile 覆写会刷新 registeredAt = 续期宽限,语义可接受。
    if (meta && now - meta.registeredAt < graceMs) continue;
    if (!isAlive(agentId)) {
      swept.push({ agentId, owner: meta?.owner || "unknown" });
      if (!dryRun) {
        agentCards.delete(agentId);
        cardMeta.delete(agentId);
      }
    }
  }
  if (swept.length) {
    logger?.warn?.(`[watchdog] ${dryRun ? "would sweep" : "swept"} ${swept.length} ghost agent card(s): ${swept.map((s) => `${s.agentId}(owner=${s.owner})`).join(", ")}`);
  }
  return swept;
}
```

- [ ] **Step 5.4: 跑测试确认通过**

```bash
node --test tests/store-agent-card-lease.test.js
```

Expected: 5 pass。

- [ ] **Step 5.5: 接线（两处）——审计修正：开机时刻幽灵不存在，真幽灵在运行期**

经核实 `index.js:137` `loadAgentCards` 开机先 `clearAgentCards()` 再按 `listRuntimeAgentIds()` 重建——**开机时刻卡与配置必然合一**；幽灵窗口在运行期且双向（create 侧 :221 先卡→:228 后配、delete 侧先配后卡），瞬态自愈但可能被并发读命中。据此两处接线：

**(a) 开机 sweep 降格为不变量守卫**（预期清出恒 0，非 0 = 装配 bug）。`index.js` gateway_start 内、`FULLY INITIALIZED` 日志行之前（**内容锚**，勿锚 Task 4 产出——保持 Task 独立可 revert）加：

```js
      // 不变量守卫:loadAgentCards 刚重建过,此处清出必须为 0;非 0 即装配 bug,warn 会记名。
      sweepAgentCards((agentId) => Boolean(getRuntimeAgentConfig(agentId)), { logger, graceMs: 0 });
```

谓词用已导入的封装 API `getRuntimeAgentConfig`（`index.js:31`，自带 id 归一化）——**勿用裸 `runtimeAgentConfigs` 集合**（它是本计划病灶 #1 要消灭的裸访问，且 index.js 根本没导入它）。`sweepAgentCards` 加入 index.js 的 agent-card-store import 列表。

**(b) 运行期兜底挂进既有周期门 `pruneStaleCollections`（`index.js:92`）**——复用现成 5 分钟维护机制，不新增触发点。在该函数体内追加（与既有清理项同列）：

```js
  // agentCards 幽灵兜底(RX-01 试点):60s 宽限盖住 create/delete 在途窗口;
  // dryRun soak 期只告警不删,确认无合法 card-only agent 误报后经用户点头改 false。
  sweepAgentCards((agentId) => Boolean(getRuntimeAgentConfig(agentId)), { logger, graceMs: 60_000, dryRun: true });
```

> **裁决点（用户）**：`agent-identity.js:78` 现行语义承认 card-only 注册（`registeredSource: "card"`）。上述谓词按 runtime 配置单边裁决，等于宣布 card-only 分支非法。默认 dryRun 观察一个 soak 期：告警若出现合法 card-only agent，谓词须并入第二真值源后才准启用删除；若确认该分支已死，推广批顺手从 agent-identity 摘除它。**dryRun→false 须用户点头。**

- [ ] **Step 5.5b: owner 实名（否则 owner 机制上线即空转——生产数据永远 unknown）**

三处真实写入点传 owner：
- `index.js` `loadAgentCards` 内的 `setAgentCard(agentId, card)` → 第三参 `"gateway_start/loadAgentCards"`
- `lib/agent/admin/agent-admin-create-delete.js:221` → `"agent-admin/create"`
- `lib/agent/admin/agent-admin-profile.js:235` 与 `:325` → `"agent-admin/profile"`

（读侧 `agent-identity.js`、`runtime-mailbox-handler-registry.js` 不动。）

- [ ] **Step 5.6: 全量测试 + commit**

```bash
cd ~/.openclaw/extensions/watchdog && node --check index.js && npm test 2>&1 | tail -5
cd ~/.openclaw && git add extensions/watchdog/lib/store/agent-card-store.js extensions/watchdog/tests/store-agent-card-lease.test.js extensions/watchdog/index.js extensions/watchdog/lib/agent/admin/agent-admin-create-delete.js extensions/watchdog/lib/agent/admin/agent-admin-profile.js && git commit -m "feat(runtime-core): agent-card-store 租约化试点 — owner实名+宽限sweep(dryRun)+撤销凭证(RX-01)

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>" -- extensions/watchdog/lib/store/agent-card-store.js extensions/watchdog/tests/store-agent-card-lease.test.js extensions/watchdog/index.js extensions/watchdog/lib/agent/admin/agent-admin-create-delete.js extensions/watchdog/lib/agent/admin/agent-admin-profile.js
```

---

## Task 6: Vendor 基线文档（RX-04，verification-docs 支撑位）

**Files:**
- Create: `~/.openclaw/docs/vendor-baseline-pi-2026-08-16.md`

- [ ] **Step 6.1: 写文档（内容如下，数字均为 2026-08-15 实测）**

```markdown
# Vendor 基线：openclaw 与 pi 执行栈（2026-08-16）

学 dsh 的 vendor 纪律（vendor/README.md：钉版 + 逐条修改日志 + 关键面清单）。
我们不 vendor 源码,但对执行栈依赖建立同等的「关键面清单 + 已知行为记录」。
升级任何一项前,对照本文件逐条核对关键面是否变化,并在下方日志追加一条。

## 钉版清单

| 包 | 版本 | 位置 | 角色 |
|---|---|---|---|
| openclaw | 2026.3.2 | 全局 npm (nvm node v25.6.1) | 平台壳:通道桥接/插件宿主 |
| @mariozechner/pi-agent-core | (随 openclaw 锁定) | openclaw/node_modules | **agent loop 本体**(dist 992 行) |
| @mariozechner/pi-coding-agent | (随 openclaw 锁定) | 同上 | 工具集/session-manager/compaction(dist 31,679 行) |
| @mariozechner/pi-ai | (随 openclaw 锁定) | 同上 | provider 抽象/EventStream(dist 21,021 行) |

## 关键面清单（升级必核对）

pi-agent-core `dist/types.d.ts` 的 AgentLoopConfig——我们未来降级式治理的全部抓手:
- `convertToLlm(messages)` **必填**:每次 LLM 调用前重写消息数组(spill 类落点)
- `transformContext(messages, signal)`:官方注释即 "Context window management (pruning old messages)"(compaction 落点)
- `getSteeringMessages()`:每次工具执行后调用,返回消息则注入并跳过剩余工具调用(劝告式 loop-breaker 落点)
- `getFollowUpMessages()`:agent 停止前追加轮次
- `getApiKey(provider)`:动态 key(短时 OAuth 场景)
- `agentLoop()` / `agentLoopContinue()`:dist/agent-loop.d.ts 仅此两导出

## 已知行为记录

- watchdog 对执行面的全部控制只经 openclaw 的 5 个 hook 事件;pi 的上述钩子
  是否被 openclaw 透传给插件配置,**尚未核实**(2026-08-15 会话结论)——升级或
  做降级治理前必须先查这一条。
- openclaw dependencies 含大量通道 SDK(slack/line/telegram/whatsapp/discord 等),
  升级主要风险面在通道桥接,而非 pi 执行栈本身。

## 升级日志

| 日期 | 动作 | 关键面变化 | 核对人 |
|---|---|---|---|
| 2026-08-16 | 建立基线 | — | (建档) |
```

- [ ] **Step 6.2: Commit**

```bash
cd ~/.openclaw && git add docs/vendor-baseline-pi-2026-08-16.md && git commit -m "docs(verification-docs): vendor 基线建档 — pi 执行栈关键面清单(RX-04)

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>" -- docs/vendor-baseline-pi-2026-08-16.md
```

---

## 收尾验证

- [ ] **V.1: 全量单测** `cd ~/.openclaw/extensions/watchdog && npm test 2>&1 | tail -5` — 与基线一致（失败⊆flaky 集）。
- [ ] **V.2: 重启网关**（error-codes.js 属 formal-runtime，suite 在网关进程内）：`launchctl kickstart -k gui/$(id -u)/ai.openclaw.gateway`
- [ ] **V.3: 零 LLM 体检** `node ~/.openclaw/extensions/watchdog/test-runner.js` — Expected: health 全绿（含 Task 4.7 新增的 boot 账本 CheckResult）；日志见 `boot deps ok: provided=4 required=3`（计数随接线数变化，revert Task4 后此断言随之失效属预期）、开机不变量 sweep 零清出、gateway_stop 重启时见 `kernelLease disposed N effect(s)`（gateway_stop 首次接线的 live 实证）。
- [ ] **V.4: 不 push**——push 与打 tag（v199-stable 候选）由用户裁决；push 前确认主备忘录是否需更新（Git+备忘录同步纪律）。

## 回滚矩阵

revert 单位 = 单 Task commit，合法顺序为逆序（Task6 → … → Task1）。要点：

- **Task3 与 Task4 已解耦**：E-CONFIG-003 入既有 config 段、E-BOOT-001 自带 kernel/boot 段，各自 revert 自含、无孤儿码。
- **Task5 不依赖 Task4**：接线锚是内容锚（FULLY INITIALIZED 日志行），revert Task4 后 Task5 照常存活，仅 V.3 的 boot deps 日志断言失效（预期内）。
- **Task2 revert 自含**：intervalHandles 的删除与恢复在同一 commit（state-collections.js + index.js + kernel-lease.js），revert 即完整还原。
- **Task1 是地基**：Task2/4/5 任一存活期间不得单独 revert。

## 推广批（明确不在本计划内，逐项另立小任务）

以 Task 5 为模板逐店收编，按板块归属分批（勿一次扫完，跨 3 块即拆）：

1. `lib/store/tracker-store.js` — 两个定时器 Map（`pendingTrackerRemovalTimers`/`pendingTrackingContractWaiters`，:12-13）入租约 → block `local-execution`。前提已备：lease 账本 Set 自压缩，高频 set/delete 换手（:42-45）不留尸体；注意该店有 clearTimeout 换手语义，收编时用"先 dispose 旧凭证再登记新凭证"表达
   ⚠ **原语升级前置**：收编任何 async close 资源（如 `run-event-recorder.js:219` 的 `await handle.close()`）之前，lease 原语须先升级出 await 语义的 disposeAll——当前同步专属是结构性拒收（thenable 即报错），别绕它
2. `lib/store/contract-store.js` — 三个模块单例（`contractSnapshotsByPath`/`contractPathsById`/`sharedContractsLoaded`，:13-15）加 owner/reset → `runtime-core`
3. 五个二代 registry：`lib/prompt/role-spec-registry.js`、`lib/prompt/semantic-skill-registry.js`、`lib/agent/agent-binding-store.js`、`lib/effective-profile-composer.js`、`lib/management/capability-registry.js` — 条目补 owner+存活谓词（原列第五项 `graph-loop-registry.js`〔原 lib/loop 下〕已随 2026-08-18 回路退役删除，不再是待收编对象）
4. `bootLedger` 声明从 index.js 种子块下放到各属主模块
5. 内核干预事件入账首例：tracker 超时判死合约时经 `appendRunEvent()` 写归因事件（`source=kernel, reason=tracker_timeout`，`causeRefs` 指向该合约的 dispatch 事件；替换现散装 `runtimeDiagnostics` 写法）— 遵循理想内核定义第 6 条 → block `runtime-core`
6. `hooks/before-tool-call.js` 411 行复合拦截拆分 + 硬停改降级 — **另立计划**（L3 执行面，非 kernel）
