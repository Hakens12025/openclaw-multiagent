import test from "node:test";
import assert from "node:assert/strict";
import { LANG_PACKS, createI18n } from "../ui/core/i18n.js";
import { enUS } from "../ui/core/i18n-keys.js";

test("i18n: 双语键表完全镜像", () => {
  const en = Object.keys(LANG_PACKS["en-US"]).sort();
  const zh = Object.keys(LANG_PACKS["zh-CN"]).sort();
  assert.deepEqual(en, zh);
});

test("i18n: t() 参数替换与回退", () => {
  const i18n = createI18n({ lang: "zh-CN" });
  assert.equal(i18n.t("pulse.queue", { n: 2 }), "队列: 2 等待中");
  i18n.setLang("en-US");
  assert.equal(i18n.t("pulse.queue", { n: 2 }), "queue: 2 waiting");
});

test("i18n: 回退链 当前语言→en-US→key 本身", () => {
  const i18n = createI18n({ lang: "zh-CN" });
  assert.equal(i18n.t("no.such.key"), "no.such.key");
  // zh-CN 缺键时回退 en-US
  const packs = LANG_PACKS;
  const zhVal = packs["zh-CN"]["nav.command"];
  delete packs["zh-CN"]["nav.command"];
  try {
    assert.equal(i18n.t("nav.command"), enUS["nav.command"]);
  } finally {
    packs["zh-CN"]["nav.command"] = zhVal;
  }
});

test("i18n: setLang 通知 store（即时无刷新切换）", () => {
  const patched = [];
  const store = { patch: (p) => patched.push(p) };
  const i18n = createI18n({ lang: "zh-CN", store });
  i18n.setLang("en-US");
  assert.deepEqual(patched, [{ lang: "en-US" }]);
});
