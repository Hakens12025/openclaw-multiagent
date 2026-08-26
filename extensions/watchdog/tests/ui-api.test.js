import test from "node:test";
import assert from "node:assert/strict";
import { createApi } from "../ui/core/api.js";

test("api.getJson: 拼 token + 错误归一", async () => {
  const calls = [];
  const api = createApi({
    token: "T",
    fetchImpl: async (url) => { calls.push(url); return { ok: true, json: async () => ({ n: 1 }) }; },
  });
  const data = await api.getJson("/watchdog/runtime");
  assert.equal(data.n, 1);
  assert.ok(calls[0].includes("token=T"));

  const bad = createApi({ token: "T", fetchImpl: async () => ({ ok: false, status: 403 }) });
  await assert.rejects(() => bad.getJson("/x"), (e) => e.kind === "auth");
});

test("api.inspect: surface 与参数拼装", async () => {
  const api = createApi({ token: "T", fetchImpl: async (url) => ({ ok: true, json: async () => ({ url }) }) });
  const r = await api.inspect("inspect.threads", { limit: 5 });
  assert.ok(r.url.includes("surface=inspect.threads") && r.url.includes("limit=5"));
});
