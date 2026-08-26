// i18n.js — 响应式 t()。lang 是 store 状态：setLang 通知 store，订阅方重渲染（无刷新切换）。
// 回退链：当前语言 → en-US → key 本身。键表镜像完整性由 tests/ui-i18n.test.js 守卫。
import { enUS, zhCN } from "./i18n-keys.js";

export const LANG_PACKS = Object.freeze({ "en-US": enUS, "zh-CN": zhCN });
export const DEFAULT_LANG = "zh-CN";

export function createI18n({ lang = DEFAULT_LANG, store = null } = {}) {
  let current = LANG_PACKS[lang] ? lang : DEFAULT_LANG;

  function lookup(key, pack) {
    const v = pack?.[key];
    return typeof v === "string" ? v : null;
  }

  function interpolate(text, params) {
    if (!params) return text;
    return text.replaceAll(/\{(\w+)\}/g, (_m, name) => String(params[name] ?? `{${name}}`));
  }

  return {
    t(key, params) {
      const text = lookup(key, LANG_PACKS[current]) ?? lookup(key, LANG_PACKS["en-US"]) ?? key;
      return interpolate(text, params);
    },
    setLang(next) {
      if (!LANG_PACKS[next] || next === current) return;
      current = next;
      store?.patch({ lang: next });
    },
    getLang: () => current,
  };
}
