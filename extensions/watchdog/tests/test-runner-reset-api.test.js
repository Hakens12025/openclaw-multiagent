import test from "node:test";
import assert from "node:assert/strict";

import {
  buildFullResetRequestBody,
  requestRuntimeReset,
  resolveFormalRuntimeConfig,
} from "../lib/formal-runtime/infra.js";

test("test infra reset helper sends canonical explicitConfirm payload", () => {
  assert.deepEqual(JSON.parse(buildFullResetRequestBody()), {
    explicitConfirm: true,
  });
});

test("requestRuntimeReset rejects non-2xx reset responses", async () => {
  await assert.rejects(
    () => requestRuntimeReset({
      fetchImpl: async () => ({
        status: 403,
        body: JSON.stringify({ error: "explicit confirmation required" }),
      }),
    }),
    /runtime reset failed: HTTP 403/,
  );
});

test("requestRuntimeReset rejects malformed reset payloads", async () => {
  await assert.rejects(
    () => requestRuntimeReset({
      fetchImpl: async () => ({
        status: 200,
        body: JSON.stringify({ ok: true }),
      }),
    }),
    /runtime reset returned malformed response/,
  );
});

test("resolveFormalRuntimeConfig rejects configs without registered runtime agents", () => {
  assert.throws(
    () => resolveFormalRuntimeConfig({
      agents: { list: [] },
      bindings: [],
    }),
    /formal runtime requires registered runtime agents/i,
  );
});
