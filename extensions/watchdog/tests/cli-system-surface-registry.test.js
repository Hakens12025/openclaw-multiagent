import test from "node:test";
import assert from "node:assert/strict";

import {
  executeCliSystemSurface,
  getCliSystemSurface,
  listCliSystemSurfaces,
  summarizeCliSystemSurfaces,
} from "../lib/cli-system/cli-surface-registry.js";
import { executeOperatorExecutablePlan } from "../lib/operator/operator-executor.js";

test("cli system registry merges hook observe and admin surfaces into one catalog", () => {
  const summary = summarizeCliSystemSurfaces();
  assert.equal(summary.counts.total > 0, true);
  assert.equal(summary.counts.byFamily.hook > 0, true);
  assert.equal(summary.counts.byFamily.observe > 0, true);
  assert.equal(summary.counts.byFamily.inspect > 0, true);
  assert.equal(summary.counts.byFamily.apply > 0, true);
  assert.equal(summary.counts.byFamily.verify > 0, true);
});

test("cli system registry resolves canonical hook and observe entries", () => {
  assert.equal(getCliSystemSurface("hook.before_tool_call")?.family, "hook");
  assert.equal(getCliSystemSurface("observe.track_progress")?.family, "observe");
});

test("cli system surfaces expose control display ids without changing canonical ids", () => {
  const hookSurface = getCliSystemSurface("hook.before_tool_call");
  const graphSurface = getCliSystemSurface("graph.edge.add");

  assert.equal(hookSurface?.id, "hook.before_tool_call");
  assert.equal(hookSurface?.displayId, "control:hook.before_tool_call");
  assert.equal(graphSurface?.id, "graph.edge.add");
  assert.equal(graphSurface?.displayId, "control:graph.edge.add");
});

test("cli system registry filters operator executable apply surfaces only", () => {
  const surfaces = listCliSystemSurfaces({
    family: "apply",
    operatorExecutable: true,
  });
  assert.equal(surfaces.some((surface) => surface.id === "agents.policy"), true);
  assert.equal(surfaces.some((surface) => surface.id === "runtime.reset"), false);
});

test("cli system registry rejects duplicate surface ids", () => {
  const surfaces = listCliSystemSurfaces();
  const ids = surfaces.map((surface) => surface.id);
  assert.deepEqual(ids, [...new Set(ids)]);
});

test("operator execution goes through cli-system surface executor", async () => {
  const operatorSource = await import("node:fs/promises")
    .then(({ readFile }) => readFile(
      new URL("../lib/operator/operator-executor.js", import.meta.url),
      "utf8",
    ));

  assert.match(operatorSource, /executeCliSystemSurface/);
  assert.doesNotMatch(operatorSource, /executeAdminSurfaceOperation/);
});

test("operator planning uses cli-system payload facade instead of admin registry directly", async () => {
  const operatorPlanSource = await import("node:fs/promises")
    .then(({ readFile }) => readFile(
      new URL("../lib/operator/operator-plan.js", import.meta.url),
      "utf8",
    ));

  assert.match(operatorPlanSource, /normalizeCliSystemSurfacePayload/);
  assert.match(operatorPlanSource, /findMissingRequiredCliSystemSurfaceFields/);
  assert.doesNotMatch(operatorPlanSource, /admin-surface-registry/);
  assert.doesNotMatch(operatorPlanSource, /normalizeAdminSurfacePayload/);
  assert.doesNotMatch(operatorPlanSource, /findMissingRequiredAdminSurfaceFields/);
});

test("operator brain exposes cli-system surfaces as the operator action catalog", async () => {
  const operatorBrainSource = await import("node:fs/promises")
    .then(({ readFile }) => readFile(
      new URL("../lib/operator/operator-brain.js", import.meta.url),
      "utf8",
    ));

  assert.match(operatorBrainSource, /listOperatorExecutableCliSystemSurfaces/);
  assert.match(operatorBrainSource, /provided cli-system surfaces/);
  assert.doesNotMatch(operatorBrainSource, /listOperatorExecutableAdminSurfaces/);
  assert.doesNotMatch(operatorBrainSource, /provided admin surfaces/);
});

test("operator snapshot derives operator surfaces from cli-system projection", async () => {
  const operatorSnapshotSource = await import("node:fs/promises")
    .then(({ readFile }) => readFile(
      new URL("../lib/operator/operator-snapshot.js", import.meta.url),
      "utf8",
    ));

  assert.match(operatorSnapshotSource, /summarizeCliSystemSurfaces/);
  assert.doesNotMatch(operatorSnapshotSource, /summarizeAdminSurfaces/);
  assert.doesNotMatch(operatorSnapshotSource, /admin-surface-registry/);
});

test("operator runtime snapshot reads runtime stores through cli-system inspector", async () => {
  const operatorRuntimeSource = await import("node:fs/promises")
    .then(({ readFile }) => readFile(
      new URL("../lib/operator/operator-snapshot-runtime.js", import.meta.url),
      "utf8",
    ));

  assert.match(operatorRuntimeSource, /cli-runtime-inspector/);
  assert.doesNotMatch(operatorRuntimeSource, /\.\.\/routing\/dispatch-runtime-state\.js/);
  assert.doesNotMatch(operatorRuntimeSource, /\.\.\/store\/tracker-store\.js/);
});

test("cli system surface executor rejects non operator-executable surfaces", async () => {
  await assert.rejects(
    () => executeCliSystemSurface({
      surfaceId: "runtime.reset",
      payload: {},
      actor: "operator",
    }),
    /not operator executable/u,
  );
});

test("cli system surface executor requires explicit meta-agent actor for executable surfaces", async () => {
  await assert.rejects(
    () => executeCliSystemSurface({
      surfaceId: "agents.policy",
      payload: {},
    }),
    /requires a meta-agent actor/u,
  );

  await assert.rejects(
    () => executeCliSystemSurface({
      surfaceId: "agents.policy",
      payload: {},
      actor: "worker",
    }),
    /requires a meta-agent actor/u,
  );
});

test("operator executable plan fails closed on non operator-executable step", async () => {
  await assert.rejects(
    () => executeOperatorExecutablePlan({
      plan: {
        intent: "platform_mutation",
        summary: "bad plan",
        steps: [
          {
            surfaceId: "runtime.reset",
            payload: {},
          },
        ],
      },
    }),
    /unsupported operator step/u,
  );
});
