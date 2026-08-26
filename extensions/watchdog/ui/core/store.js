// store.js — 单一数据源。SSE/轮询只写，组件只读+订阅。
export function createStore(initial) {
  let state = { ...initial };
  const listeners = new Set();
  return {
    get: () => state,
    patch(partial) {
      const changed = Object.keys(partial).filter((k) => state[k] !== partial[k]);
      if (!changed.length) return;
      state = { ...state, ...partial };
      for (const fn of listeners) fn(state, changed);
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
