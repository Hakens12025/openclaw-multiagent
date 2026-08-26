import test from "node:test";
import assert from "node:assert/strict";
import { accessSync, readFileSync } from "node:fs";
import { constants as fsConstants } from "node:fs";

import { SURFACE_INPUT_FIELDS } from "../lib/admin/admin-surface-input-fields.js";

test("admin surface placeholders avoid stale legacy agent examples", () => {
  const agentJoinFields = SURFACE_INPUT_FIELDS["agent_joins.create"] || [];

  assert.equal("runtime.workspace_migration.apply" in SURFACE_INPUT_FIELDS, false);
  // 回路面退役(2026-08-18):graph.loop.compose / runtime.loop.start 两组输入字段
  // 随 surface 一起消失,原本挂在它们身上的过时示例守卫改为「surface 不得复活」。
  assert.equal("graph.loop.compose" in SURFACE_INPUT_FIELDS, false);
  assert.equal("runtime.loop.start" in SURFACE_INPUT_FIELDS, false);
  assert.doesNotMatch(
    agentJoinFields[1]?.placeholder || "",
    /deerflow-researcher/i,
  );
});


test("runtime admin reset fallback avoids stale legacy worker defaults", () => {
  const source = readFileSync(
    new URL("../lib/admin/runtime-admin.js", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(source, /"worker-a"|"worker-b"|"worker-c"|"worker-d"/);
});











test("runtime timeout cleanup avoids retired disabled pipeline monitor", () => {
  const constantsSource = readFileSync(
    new URL("../lib/state/state-constants.js", import.meta.url),
    "utf8",
  );
  const indexSource = readFileSync(
    new URL("../index.js", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(constantsSource, /PIPELINE_STAGE_TIMEOUT_MS/u);
  assert.doesNotMatch(indexSource, /PIPELINE_STAGE_TIMEOUT_MS/u);
  assert.doesNotMatch(constantsSource, /RUNTIME_STAGE_TIMEOUT_MS/u);
  assert.doesNotMatch(indexSource, /RUNTIME_STAGE_TIMEOUT_MS/u);
  assert.doesNotMatch(indexSource, /AUTO_PIPELINE_STAGE_TIMEOUT_ENABLED/u);
  assert.doesNotMatch(indexSource, /pipeline_stage_timeout/u);
  assert.doesNotMatch(indexSource, /pipeline stage timeout/u);
});

test("tracker timeout recovery avoids retired pipeline naming", () => {
  const source = readFileSync(new URL("../index.js", import.meta.url), "utf8");

  const retiredPatterns = [
    /\bresolveTrackerTimeoutPipelineStage\b/u,
    /\bactivePipeline\b/u,
    /\beffectivePipelineStage\b/u,
    /\bconst pipelineStage\b/u,
    /pipelineStage,\n\s*\}/u,
  ];

  const violations = retiredPatterns
    .filter((pattern) => pattern.test(source))
    .map((pattern) => `index matches ${pattern}`);

  assert.deepEqual(violations, []);
});

test("late-completion lease machinery stays retired (2026-08-26 死码清理)", () => {
  // 模块本体已删(arm 侧 v136 退役后读侧恒 null,零真实消费者)。
  assert.throws(
    () => accessSync(new URL("../lib/late-completion-lease.js", import.meta.url), fsConstants.F_OK),
    /ENOENT/,
  );

  // 曾经的两处死引用不得复活:agent_end 空转 consume + tracker 终态判定恒 falsy 检查。
  // ⚠ followUpLease 是活机制,此守卫只针对 lateCompletionLease。
  const sources = {
    lifecycle: readFileSync(new URL("../lib/lifecycle/agent-end/lifecycle.js", import.meta.url), "utf8"),
    trackerStore: readFileSync(new URL("../lib/store/tracker-store.js", import.meta.url), "utf8"),
  };
  for (const [label, source] of Object.entries(sources)) {
    assert.doesNotMatch(
      source,
      /lateCompletionLease|consumeLateCompletionLease/u,
      `${label} 仍引用已退役的 late-completion lease`,
    );
  }
});

test("artifact lane residue stays removed from tracking snapshots (2026-08-26 死码清理)", () => {
  // artifact 车道(v218 收店)残留的 4 个恒 null 快照字段,零消费者,不得复活。
  const sources = {
    lifecycleBuilders: readFileSync(new URL("../lib/contract/contract-lifecycle-builders.js", import.meta.url), "utf8"),
    sse: readFileSync(new URL("../lib/transport/sse.js", import.meta.url), "utf8"),
  };
  for (const [label, source] of Object.entries(sources)) {
    assert.doesNotMatch(
      source,
      /artifactKind|artifactDomain|artifactSource|artifactRequest/u,
      `${label} 仍发射已退役的 artifact* 快照字段`,
    );
  }
});

test("run events file-ledger symbols stay retired (2026-08-26 死码清理)", () => {
  // 文件账已随 v232 SQLite 终态退役:events.jsonl 定址符号不得复活。
  const source = readFileSync(new URL("../lib/archive/thread-tree-store.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /RUN_EVENTS_FILENAME|runEventsFileFor/u);
});

test("hard-path autoexec channel stays retired (2026-08-26 死码清理)", () => {
  // 模块整删:触发字段 _hardPath 从不在 inbox 投影白名单(TASK_FACING_INBOX_ALLOW_KEYS),
  // 通道生产不可达,却带着 execAsync 躺在 security/。
  assert.throws(
    () => accessSync(new URL("../lib/security/hard-path-autoexec.js", import.meta.url), fsConstants.F_OK),
    /ENOENT/,
  );
  const sources = {
    beforeAgentStart: readFileSync(new URL("../hooks/before-agent-start.js", import.meta.url), "utf8"),
    sessionTrackingState: readFileSync(new URL("../lib/session/session-tracking-state.js", import.meta.url), "utf8"),
  };
  for (const [label, source] of Object.entries(sources)) {
    assert.doesNotMatch(
      source,
      /runWorkerHardPathAutoExec|_hardPath/u,
      `${label} 仍引用已退役的 hard-path autoexec 通道`,
    );
  }
});

test("active lifecycle comments avoid retired pipeline wording", () => {
  // （evidence/reviewerResult 两个 harness 源已随 harness 全退役删除，v226）
  const sources = {
    agentEndTerminal: readFileSync(new URL("../lib/lifecycle/agent-end/terminal.js", import.meta.url), "utf8"),
    stageProjection: readFileSync(new URL("../lib/stage/stage-projection.js", import.meta.url), "utf8"),
  };

  const retiredPatterns = [
    /pipeline\.conclusionArtifact\.path/u,
    /pipeline gate/u,
    /break the pipeline/u,
    /Wait for a pipeline stage/u,
    /pipeline runtime truth/u,
    /No pipeline\/loop dependency/u,
    /No loop runtime dependency/u,
  ];

  const violations = [];
  for (const [label, source] of Object.entries(sources)) {
    for (const pattern of retiredPatterns) {
      if (pattern.test(source)) violations.push(`${label} matches ${pattern}`);
    }
  }

  assert.deepEqual(violations, []);
});

test("agent-end lifecycle runner avoids retired pipeline shell names", () => {
  assert.throws(
    () => accessSync(new URL("../lib/lifecycle/agent-end/pipeline.js", import.meta.url), fsConstants.F_OK),
    /ENOENT/,
  );

  const sources = {
    hook: readFileSync(new URL("../hooks/agent-end.js", import.meta.url), "utf8"),
    reconcile: readFileSync(new URL("../lib/protocol/protocol-commit-reconcile.js", import.meta.url), "utf8"),
    lifecycle: readFileSync(new URL("../lib/lifecycle/agent-end/lifecycle.js", import.meta.url), "utf8"),
    deferredReleaseTest: readFileSync(new URL("./agent-end-deferred-release.test.js", import.meta.url), "utf8"),
  };

  const retiredPatterns = [
    /agent-end-pipeline\.js/u,
    /\brunAgentEndPipeline\b/u,
    /\bcreateAgentEndPipelineContext\b/u,
    /\bpipelineContext\b/u,
    /agent_end_pipeline_completed/u,
    /\bcalls\.pipeline\b/u,
  ];

  const violations = [];
  for (const [label, source] of Object.entries(sources)) {
    for (const pattern of retiredPatterns) {
      if (pattern.test(source)) violations.push(`${label} matches ${pattern}`);
    }
  }

  assert.deepEqual(violations, []);
});


test("automation loop terminal handling avoids retired pipeline helper names", () => {
  const sources = {
    executor: readFileSync(new URL("../lib/automation/automation-executor.js", import.meta.url), "utf8"),
    lifecycle: readFileSync(new URL("../lib/automation/automation-round-context.js", import.meta.url), "utf8"),
    extractors: readFileSync(new URL("../lib/automation/automation-result-extractors.js", import.meta.url), "utf8"),
  };

  const retiredPatterns = [
    /\bhandleAutomationPipelineTerminal\b/u,
    /\bisPipelineActive\b/u,
    /\bextractPipeline(?:Score|Artifact|Summary)\b/u,
    /\bderivePipelineTerminalStatus\b/u,
    /\bactivePipeline\b/u,
    /\bactivePipelineRuntime\b/u,
    /\bautomation_pipeline_running\b/u,
    /\bpipeline_not_terminal\b/u,
    /\brecovered_pipeline_terminal\b/u,
    /\bpipeline_busy\b/u,
    /\bpipelineAction\b/u,
  ];

  const violations = [];
  for (const [label, source] of Object.entries(sources)) {
    for (const pattern of retiredPatterns) {
      if (pattern.test(source)) violations.push(`${label} matches ${pattern}`);
    }
  }

  assert.deepEqual(violations, []);
});
