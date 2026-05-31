import test from "node:test";
import assert from "node:assert/strict";

import { composeEffectiveProfile } from "../lib/effective-profile-composer.js";
import { registerRuntimeAgents, getAgentIdentitySnapshot } from "../lib/agent/agent-identity.js";
import { resolveActorPlanePolicy } from "../lib/agent/agent-plane-policy.js";
import { buildConfiguredCandidate } from "../lib/agent/agent-enrollment-discovery.js";
import { runtimeAgentConfigs } from "../lib/state.js";

test.afterEach(() => {
  runtimeAgentConfigs.clear();
});

test("controller is runtime-visible and auto-wake eligible", () => {
  assert.deepEqual(
    resolveActorPlanePolicy({
      agentId: "controller",
      role: "bridge",
      gateway: true,
      ingressSource: "webui",
    }),
    {
      plane: "runtime",
      mainViewVisible: true,
      formalTimelineVisible: true,
      autoWakeEligible: true,
    },
  );
});

test("operator is a hidden control-plane agent", () => {
  assert.deepEqual(
    resolveActorPlanePolicy({
      agentId: "operator",
      role: "agent",
      gateway: false,
      ingressSource: null,
    }),
    {
      plane: "control_plane",
      mainViewVisible: false,
      formalTimelineVisible: false,
      autoWakeEligible: false,
    },
  );
});

test("control-layer actors default to hidden control-plane agents", () => {
  for (const agentId of ["harness", "cli-system", "automation"]) {
    assert.deepEqual(
      resolveActorPlanePolicy({
        agentId,
        role: "agent",
        gateway: false,
        ingressSource: null,
      }),
      {
        plane: "control_plane",
        mainViewVisible: false,
        formalTimelineVisible: false,
        autoWakeEligible: false,
      },
    );
  }
});

test("effective profile projects actor plane policy", () => {
  const config = {
    agents: {
      list: [
        {
          id: "operator",
          role: "agent",
          workspace: "~/.openclaw/workspaces/operator",
        },
      ],
    },
  };

  const profile = composeEffectiveProfile({
    config,
    agentConfig: config.agents.list[0],
  });

  assert.equal(profile.id, "operator");
  assert.equal(profile.plane, "control_plane");
  assert.equal(profile.mainViewVisible, false);
  assert.equal(profile.formalTimelineVisible, false);
  assert.equal(profile.autoWakeEligible, false);
});

test("configured control-plane agents are not main-view roster entries", async () => {
  const candidate = await buildConfiguredCandidate({
    id: "operator",
    role: "agent",
    workspace: "~/.openclaw/workspaces/operator",
  }, {
    agents: { list: [] },
  });

  assert.equal(candidate?.mainViewVisible, false);
});

test("runtime agent registration preserves explicit hidden control-plane policy", () => {
  registerRuntimeAgents({
    agents: {
      list: [
        {
          id: "maintenance-control",
          role: "agent",
          workspace: "~/.openclaw/workspaces/maintenance-control",
          plane: "control_plane",
          mainViewVisible: false,
          formalTimelineVisible: false,
          autoWakeEligible: false,
        },
      ],
    },
  });

  const snapshot = getAgentIdentitySnapshot("maintenance-control");
  assert.equal(snapshot.registered, true);
  assert.equal(snapshot.plane, "control_plane");
  assert.equal(snapshot.mainViewVisible, false);
  assert.equal(snapshot.formalTimelineVisible, false);
  assert.equal(snapshot.autoWakeEligible, false);
});
