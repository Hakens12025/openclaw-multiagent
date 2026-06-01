import test from "node:test";
import assert from "node:assert/strict";
import { accessSync, readFileSync } from "node:fs";
import { constants as fsConstants } from "node:fs";

import { SURFACE_INPUT_FIELDS } from "../lib/admin/admin-surface-input-fields.js";

test("admin surface placeholders avoid stale legacy agent examples", () => {
  const loopComposeFields = SURFACE_INPUT_FIELDS["graph.loop.compose"] || [];
  const runtimeLoopStartFields = SURFACE_INPUT_FIELDS["runtime.loop.start"] || [];
  const agentJoinFields = SURFACE_INPUT_FIELDS["agent_joins.create"] || [];

  assert.equal("runtime.workspace_migration.apply" in SURFACE_INPUT_FIELDS, false);
  assert.doesNotMatch(
    loopComposeFields[0]?.placeholder || "",
    /researcher|worker-d|reviewer/i,
  );
  assert.doesNotMatch(
    runtimeLoopStartFields[2]?.placeholder || "",
    /researcher/i,
  );
  assert.doesNotMatch(
    agentJoinFields[1]?.placeholder || "",
    /deerflow-researcher/i,
  );
});

test("dashboard operator compose placeholder avoids stale legacy topology examples", () => {
  const source = readFileSync(
    new URL("../dashboard-operator.js", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(source, /worker-a|worker-d|reviewer/);
});

test("runtime admin reset fallback avoids stale legacy worker defaults", () => {
  const source = readFileSync(
    new URL("../lib/admin/runtime-admin.js", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(source, /"worker-a"|"worker-b"|"worker-c"|"worker-d"/);
});

test("agents dashboard no longer renders workspace migration compatibility panel", () => {
  const source = readFileSync(
    new URL("../dashboard-agents.js", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(source, /LEGACY WORKSPACE ALIASES/);
  assert.doesNotMatch(source, /workspace-migration/i);
});

test("contract flow cards stay icon-first and use visible dispatch animation timing", () => {
  const cardSource = readFileSync(
    new URL("../dashboard-contract-card.js", import.meta.url),
    "utf8",
  );
  const cssSource = readFileSync(
    new URL("../dashboard-graph.css", import.meta.url),
    "utf8",
  );
  const animatorSource = readFileSync(
    new URL("../dashboard-contract-flow-animator.js", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(cardSource, /contract-flow-card-label/);
  assert.match(cssSource, /contract-flow-flash 1\.[2-9]s/u);
  assert.match(animatorSource, /setTimeout\([^,]+,\s*1[2-9]00\)/u);
});

test("main lifecycle list uses work item card naming distinct from graph contract cards", () => {
  const dashboardSource = readFileSync(
    new URL("../dashboard.js", import.meta.url),
    "utf8",
  );
  const homeCssSource = readFileSync(
    new URL("../dashboard-home.css", import.meta.url),
    "utf8",
  );

  assert.match(dashboardSource, /class="work-item-card status-\$\{status\}/u);
  assert.doesNotMatch(dashboardSource, /class="contract-card status-/u);
  assert.match(homeCssSource, /\.work-item-card\b/u);
  assert.doesNotMatch(homeCssSource, /\.contract-card\b/u);
});

test("dashboard init failure reporting preserves the existing document body", () => {
  const initSource = readFileSync(
    new URL("../dashboard-init.js", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(initSource, /document\.body\.innerHTML\s*=/u);
  assert.match(initSource, /dashboardInitError/u);
});

test("dashboard graph rebuild guards missing svg container before clearing graph state", () => {
  const svgSource = readFileSync(
    new URL("../dashboard-svg.js", import.meta.url),
    "utf8",
  );

  assert.match(svgSource, /const svg = document\.getElementById\('runtimeGraphSvg'\);\s*if \(!svg\) return false;/u);
  assert.match(svgSource, /return true;/u);
});

test("dashboard core avoids unguarded direct DOM writes during init and SSE handling", () => {
  const dashboardSource = readFileSync(
    new URL("../dashboard.js", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(
    dashboardSource,
    /document\.getElementById\([^)\n]+\)\.(?:textContent|innerHTML|classList|style|value)\b/u,
  );
});

test("dashboard visible work item copy uses graph route terminology instead of retired pipeline wording", () => {
  const dashboardSource = readFileSync(
    new URL("../dashboard.js", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(dashboardSource, /<dt>PIPELINE<\/dt>/u);
  assert.doesNotMatch(dashboardSource, /no active pipeline/u);
  assert.match(dashboardSource, /<dt>GRAPH ROUTE<\/dt>/u);
  assert.match(dashboardSource, /no active graph route/u);
});

test("dashboard projection API avoids retired pipeline shell names", () => {
  assert.throws(
    () => accessSync(new URL("../dashboard-pipeline.js", import.meta.url), fsConstants.F_OK),
    /ENOENT/,
  );

  const sources = {
    dashboard: readFileSync(new URL("../dashboard.js", import.meta.url), "utf8"),
    runtimeGraph: readFileSync(new URL("../dashboard-runtime-graph.js", import.meta.url), "utf8"),
    graph: readFileSync(new URL("../dashboard-graph.js", import.meta.url), "utf8"),
    drag: readFileSync(new URL("../dashboard-drag.js", import.meta.url), "utf8"),
    init: readFileSync(new URL("../dashboard-init.js", import.meta.url), "utf8"),
    svg: readFileSync(new URL("../dashboard-svg.js", import.meta.url), "utf8"),
  };

  const retiredPatterns = [
    /dashboard-pipeline\.js/u,
    /\bbuildPipelineSVG\b/u,
    /\bupdatePipeline\b/u,
    /\bgetPipelineAgentId\b/u,
    /\bisVisiblePipelineAgentId\b/u,
    /\bgetPipelineAggregateAgentIds\b/u,
    /\bgetWorkItemPipelineProgression\b/u,
    /\bdescribePipelineProgression\b/u,
    /_visiblePipelineAgentIds/u,
  ];

  const violations = [];
  for (const [label, source] of Object.entries(sources)) {
    for (const pattern of retiredPatterns) {
      if (pattern.test(source)) violations.push(`${label} matches ${pattern}`);
    }
  }

  assert.deepEqual(violations, []);
});

test("dashboard runtime graph DOM avoids retired pipeline projection names", () => {
  const sources = {
    html: readFileSync(new URL("../dashboard.html", import.meta.url), "utf8"),
    css: readFileSync(new URL("../dashboard-graph.css", import.meta.url), "utf8"),
    svg: readFileSync(new URL("../dashboard-svg.js", import.meta.url), "utf8"),
    graph: readFileSync(new URL("../dashboard-graph.js", import.meta.url), "utf8"),
    drag: readFileSync(new URL("../dashboard-drag.js", import.meta.url), "utf8"),
    ux: readFileSync(new URL("../dashboard-ux.js", import.meta.url), "utf8"),
    animator: readFileSync(new URL("../dashboard-contract-flow-animator.js", import.meta.url), "utf8"),
    i18n: readFileSync(new URL("../dashboard-i18n.js", import.meta.url), "utf8"),
  };

  const retiredPatterns = [
    /pipelineSvg/u,
    /pipeline-wrap/u,
    /pipeline-svg/u,
    /pipeline-node/u,
    /pipeline-toolbar/u,
    /pipeline-label-meta/u,
    /pipelineLoopState/u,
    /pipelineProgressState/u,
    /pipeline-loop-state/u,
    /pipeline-progress-state/u,
    /panel\.dispatch_pipeline/u,
  ];

  const violations = [];
  for (const [label, source] of Object.entries(sources)) {
    for (const pattern of retiredPatterns) {
      if (pattern.test(source)) violations.push(`${label} matches ${pattern}`);
    }
  }

  assert.deepEqual(violations, []);
});

test("harness dashboard copy uses loop naming instead of pipeline labels", () => {
  const sources = {
    runs: readFileSync(new URL("../dashboard-harness-runs.js", import.meta.url), "utf8"),
    shared: readFileSync(new URL("../dashboard-harness-shared.js", import.meta.url), "utf8"),
  };

  const violations = [];
  for (const [label, source] of Object.entries(sources)) {
    if (/label_pipeline/u.test(source)) violations.push(`${label} still uses label_pipeline`);
    if (/"Pipeline"/u.test(source)) violations.push(`${label} still renders Pipeline label`);
    if (/"管线"/u.test(source)) violations.push(`${label} still renders 管线 label`);
  }

  assert.deepEqual(violations, []);
});

test("dashboard tooltip and model picker guard missing graph containers", () => {
  const uxSource = readFileSync(
    new URL("../dashboard-ux.js", import.meta.url),
    "utf8",
  );

  assert.match(uxSource, /if \(!svg \|\| typeof svg\.getScreenCTM !== 'function'\) return;/u);
  assert.match(uxSource, /if \(!wrap\) return;/u);
});

test("runtime timeout cleanup avoids retired disabled pipeline monitor", () => {
  const constantsSource = readFileSync(
    new URL("../lib/state-constants.js", import.meta.url),
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

test("tracker timeout late-completion recovery uses loop runtime naming", () => {
  const sources = {
    index: readFileSync(new URL("../index.js", import.meta.url), "utf8"),
    lease: readFileSync(new URL("../lib/late-completion-lease.js", import.meta.url), "utf8"),
  };

  const retiredPatterns = [
    /\bresolveTrackerTimeoutPipelineStage\b/u,
    /\bactivePipeline\b/u,
    /\beffectivePipelineStage\b/u,
    /\bconst pipelineStage\b/u,
    /pipelineStage,\n\s*\}/u,
  ];

  const violations = [];
  for (const [label, source] of Object.entries(sources)) {
    for (const pattern of retiredPatterns) {
      if (pattern.test(source)) violations.push(`${label} matches ${pattern}`);
    }
  }

  assert.deepEqual(violations, []);
});

test("formal loop runtime cases avoid retired pipeline labels", () => {
  const sources = {
    loopDirect: readFileSync(new URL("../lib/formal-runtime/suite-loop-direct.js", import.meta.url), "utf8"),
  };

  const violations = [];
  for (const [label, source] of Object.entries(sources)) {
    if (/Pipeline truth matches loop start/u.test(source)) {
      violations.push(`${label} still uses retired pipeline truth label`);
    }
  }

  assert.deepEqual(violations, []);
});

test("active harness and lifecycle comments avoid retired pipeline wording", () => {
  const sources = {
    evidence: readFileSync(new URL("../lib/harness/harness-module-evidence.js", import.meta.url), "utf8"),
    reviewerResult: readFileSync(new URL("../lib/harness/reviewer-result.js", import.meta.url), "utf8"),
    agentEndTerminal: readFileSync(new URL("../lib/lifecycle/agent-end-terminal.js", import.meta.url), "utf8"),
    loopSessionStore: readFileSync(new URL("../lib/loop/loop-session-store.js", import.meta.url), "utf8"),
    stageProjection: readFileSync(new URL("../lib/stage-projection.js", import.meta.url), "utf8"),
    suiteLoopLive: readFileSync(new URL("./suite-loop-live.js", import.meta.url), "utf8"),
  };

  const retiredPatterns = [
    /pipeline\.conclusionArtifact\.path/u,
    /pipeline gate/u,
    /break the pipeline/u,
    /Wait for a pipeline stage/u,
    /pipeline runtime truth/u,
    /No pipeline\/loop dependency/u,
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
    () => accessSync(new URL("../lib/lifecycle/agent-end-pipeline.js", import.meta.url), fsConstants.F_OK),
    /ENOENT/,
  );

  const sources = {
    hook: readFileSync(new URL("../hooks/agent-end.js", import.meta.url), "utf8"),
    reconcile: readFileSync(new URL("../lib/protocol-commit-reconcile.js", import.meta.url), "utf8"),
    lifecycle: readFileSync(new URL("../lib/lifecycle/agent-end-lifecycle.js", import.meta.url), "utf8"),
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

test("runtime graph-route progression avoids retired pipeline diagnostic names", () => {
  const sources = {
    dashboard: readFileSync(new URL("../dashboard.js", import.meta.url), "utf8"),
    graphRoute: readFileSync(new URL("../lib/lifecycle/agent-end-graph-route.js", import.meta.url), "utf8"),
    operatorSnapshot: readFileSync(new URL("../lib/operator/operator-snapshot.js", import.meta.url), "utf8"),
    operatorRuntime: readFileSync(new URL("../lib/operator/operator-snapshot-runtime.js", import.meta.url), "utf8"),
    operatorSummarizers: readFileSync(new URL("../lib/operator/operator-snapshot-summarizers.js", import.meta.url), "utf8"),
  };

  const retiredPatterns = [
    /\bpipelineProgression\b/u,
    /\bPipelineProgression\b/u,
    /\blatestPipelineProgression\b/u,
    /\brecentPipelineProgressions\b/u,
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
    lifecycle: readFileSync(new URL("../lib/automation/automation-harness-lifecycle.js", import.meta.url), "utf8"),
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
