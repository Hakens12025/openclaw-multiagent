import test from "node:test";
import assert from "node:assert/strict";

import { setLang } from "../dashboard-i18n.js";
import { formatKind } from "../dashboard-harness-shared.js";

test("formatKind does not special-case removed legacy adapter kind in zh-CN", () => {
  setLang("zh-CN");
  assert.equal(formatKind("adapter"), "模块");
});

test("formatKind does not special-case removed legacy adapter kind in en-US", () => {
  setLang("en-US");
  assert.equal(formatKind("adapter"), "Module");
});
