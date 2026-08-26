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
