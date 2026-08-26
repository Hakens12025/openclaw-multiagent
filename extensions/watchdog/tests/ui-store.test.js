import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../ui/core/store.js";

test("store: get/patch/subscribe/退订", () => {
  const store = createStore({ lang: "zh-CN", items: [] });
  const seen = [];
  const off = store.subscribe((s, changed) => seen.push(changed));
  store.patch({ lang: "en-US" });
  assert.equal(store.get().lang, "en-US");
  assert.deepEqual(seen, [["lang"]]);
  off();
  store.patch({ lang: "zh-CN" });
  assert.equal(seen.length, 1, "退订后不再通知");
});

test("store: patch 相同值不触发通知", () => {
  const store = createStore({ a: 1 });
  let calls = 0;
  store.subscribe(() => calls++);
  store.patch({ a: 1 });
  assert.equal(calls, 0);
});
