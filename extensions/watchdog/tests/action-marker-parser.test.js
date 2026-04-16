import test from "node:test";
import assert from "node:assert/strict";

import { extractActionMarkers } from "../lib/action-marker-parser.js";

test("extractActionMarkers parses JSON create_task markers with rich params", () => {
  const markers = extractActionMarkers([
    "# Demo",
    "[ACTION] {\"type\":\"create_task\",\"params\":{\"message\":\"请只回复 CHILD_OK\",\"source\":\"webui\",\"phases\":[\"分析\",\"产出\"]}}",
  ].join("\n"));

  assert.equal(markers.length, 1);
  assert.equal(markers[0]?.type, "create_task");
  assert.deepEqual(markers[0]?.params, {
    message: "请只回复 CHILD_OK",
    source: "webui",
    phases: ["分析", "产出"],
  });
  assert.equal(markers[0]?.protocol?.transport, "system_action");
  assert.equal(markers[0]?.protocol?.intentType, "create_task");
  assert.equal(typeof markers[0]?.protocol?.version, "number");
});

test("extractActionMarkers parses JSON assign_task markers with explicit target and instruction", () => {
  const markers = extractActionMarkers(
    "[ACTION] {\"type\":\"assign_task\",\"params\":{\"targetAgent\":\"worker-a\",\"instruction\":\"请写入结果后停止\",\"reason\":\"probe\"}}",
  );

  assert.equal(markers.length, 1);
  assert.equal(markers[0]?.type, "assign_task");
  assert.deepEqual(markers[0]?.params, {
    targetAgent: "worker-a",
    instruction: "请写入结果后停止",
    reason: "probe",
  });
  assert.equal(markers[0]?.protocol?.transport, "system_action");
  assert.equal(markers[0]?.protocol?.intentType, "assign_task");
  assert.equal(typeof markers[0]?.protocol?.version, "number");
});

test("extractActionMarkers parses JSON request_review markers with artifact manifest", () => {
  const markers = extractActionMarkers(
    "[ACTION] {\"type\":\"request_review\",\"params\":{\"instruction\":\"请检查未定义变量\",\"artifactManifest\":[{\"path\":\"/tmp/review.js\",\"label\":\"review_probe\"}]}}",
  );

  assert.equal(markers.length, 1);
  assert.equal(markers[0]?.type, "request_review");
  assert.deepEqual(markers[0]?.params, {
    instruction: "请检查未定义变量",
    artifactManifest: [
      {
        path: "/tmp/review.js",
        label: "review_probe",
      },
    ],
  });
  assert.equal(markers[0]?.protocol?.transport, "system_action");
  assert.equal(markers[0]?.protocol?.intentType, "request_review");
  assert.equal(typeof markers[0]?.protocol?.version, "number");
});

test("extractActionMarkers maps shorthand delegate markers to assign_task semantics", () => {
  const markers = extractActionMarkers(
    "[ACTION] delegate worker-a - 请把结果写入 output 后停止",
  );

  assert.equal(markers.length, 1);
  assert.equal(markers[0]?.type, "assign_task");
  assert.deepEqual(markers[0]?.params, {
    targetAgent: "worker-a",
    instruction: "请把结果写入 output 后停止",
  });
  assert.equal(markers[0]?.protocol?.transport, "system_action");
  assert.equal(markers[0]?.protocol?.intentType, "assign_task");
  assert.equal(typeof markers[0]?.protocol?.version, "number");
});
