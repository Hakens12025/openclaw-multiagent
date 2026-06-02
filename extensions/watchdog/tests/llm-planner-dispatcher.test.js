import test from "node:test";
import assert from "node:assert/strict";

// glm-socket fix: the planner derives a long-timeout undici Agent from the global dispatcher's own
// constructor (we have 0 deps, can't import undici). This validates the mechanism the planner relies
// on: after the first fetch registers the global Agent, the symbol + ctor are present and a
// long-timeout Agent constructs. (undici default headers/body timeout is 300s; a loaded reasoning
// model exceeds it → UND_ERR_SOCKET; the long-timeout dispatcher fixes the GLM fallback.)

test("global undici dispatcher exposes an Agent constructor that accepts long timeouts", async () => {
  // Trigger fetch so undici lazily installs its global dispatcher (invalid port → fails, that's fine).
  await fetch("http://127.0.0.1:0/").catch(() => {});

  const sym = Object.getOwnPropertySymbols(globalThis).find((s) => s.description === "undici.globalDispatcher.1");
  assert.ok(sym, "global undici dispatcher symbol must be present");
  const AgentCtor = globalThis[sym]?.constructor;
  assert.equal(typeof AgentCtor, "function", "global dispatcher must expose a constructor");
  assert.doesNotThrow(
    () => new AgentCtor({ headersTimeout: 0, bodyTimeout: 0, keepAliveTimeout: 600000 }),
    "a long-timeout Agent must construct from the global dispatcher's ctor",
  );
});
