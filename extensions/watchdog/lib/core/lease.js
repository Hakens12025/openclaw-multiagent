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
