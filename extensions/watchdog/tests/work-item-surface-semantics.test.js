import test from "node:test";
import assert from "node:assert/strict";
import { unlink } from "node:fs/promises";

import { buildOperatorSnapshot } from "../lib/operator/operator-snapshot.js";
import { getContractPath, persistContractById } from "../lib/contracts.js";
import { evictContractSnapshotByPath } from "../lib/store/contract-store.js";
import { clearTrackingStore, rememberTrackingState } from "../lib/store/tracker-store.js";
import {
  buildDraftRelations,
  summarizeDraftWithRelations,
} from "../lib/operator/operator-snapshot-draft-relations.js";

function buildTestLogger() {
  return {
    info() {},
    warn() {},
    error() {},
  };
}

test("operator snapshot exposes lifecycle work through workItems semantics", async () => {
  const contractId = `TC-WORK-ITEM-SNAPSHOT-${Date.now()}`;
  const contractPath = getContractPath(contractId);

  try {
    await persistContractById({
      id: contractId,
      task: "Expose lifecycle work item semantics in operator snapshot",
      assignee: "worker-a",
      status: "running",
      createdAt: Date.now() - 2000,
      updatedAt: Date.now(),
    }, buildTestLogger());

    const snapshot = await buildOperatorSnapshot({ listLimit: 10 });

    assert.equal("contracts" in snapshot, false);
    assert.equal("activeContracts" in (snapshot.summary || {}), false);
    assert.ok(snapshot.workItems, "expected workItems section");
    assert.ok(Array.isArray(snapshot.workItems.active), "expected active work item list");
    assert.ok(snapshot.workItems.active.some((item) => item?.id === contractId), "expected inserted work item in active list");
  assert.equal(snapshot.summary.activeWorkItems >= 1, true);
  } finally {
    evictContractSnapshotByPath(contractPath);
    await unlink(contractPath).catch(() => {});
  }
});

test("operator snapshot does not treat legacy draft execution contracts as active work items", async () => {
  const contractId = `TC-WORK-ITEM-DRAFT-${Date.now()}`;
  const contractPath = getContractPath(contractId);

  try {
    await persistContractById({
      id: contractId,
      task: "Legacy draft execution contract should not look active",
      assignee: "planner",
      status: "draft",
      createdAt: Date.now() - 2000,
      updatedAt: Date.now(),
    }, buildTestLogger());

    const snapshot = await buildOperatorSnapshot({ listLimit: 10 });

    assert.ok(snapshot.workItems.active.every((item) => item?.id !== contractId));
    assert.equal("draft" in (snapshot.workItems.counts || {}), false);
  } finally {
    evictContractSnapshotByPath(contractPath);
    await unlink(contractPath).catch(() => {});
  }
});

test("draft relation summaries expose related work items instead of contracts", () => {
  const drafts = [{
    id: "ACS-WORK-ITEM-RELATION",
    surfaceId: "graph.edge.add",
    title: "Add edge",
    status: "applied",
  }];
  const workItems = [{
    id: "TC-WORK-ITEM-RELATION",
    task: "Track related lifecycle work item",
    status: "running",
    operatorContext: {
      originDraftId: "ACS-WORK-ITEM-RELATION",
    },
  }];

  const relations = buildDraftRelations(drafts, workItems, [], []);
  const summary = summarizeDraftWithRelations(drafts[0], relations.get("ACS-WORK-ITEM-RELATION"), 5);

  assert.equal(summary.nextAction, "track_related_work_items");
  assert.equal("activeContracts" in (summary.related || {}), false);
  assert.ok(Array.isArray(summary.related.activeWorkItems), "expected activeWorkItems relation slice");
  assert.equal(summary.related.activeWorkItems[0]?.id, "TC-WORK-ITEM-RELATION");
  assert.equal(summary.links.workItems, "/watchdog/work-items");
  assert.equal(summary.recommendedAction?.nextSurfaceId, "work_items.list");
  assert.equal(summary.recommendedAction?.nextPath, "/watchdog/work-items");
});

test("draft relations ignore legacy draft execution work items", () => {
  const drafts = [{
    id: "ACS-WORK-ITEM-DRAFT",
    surfaceId: "graph.edge.add",
    title: "Add edge",
    status: "applied",
  }];
  const workItems = [{
    id: "TC-WORK-ITEM-DRAFT-RELATION",
    task: "Legacy draft relation should not look active",
    status: "draft",
    operatorContext: {
      originDraftId: "ACS-WORK-ITEM-DRAFT",
    },
  }];

  const relations = buildDraftRelations(drafts, workItems, [], []);

  assert.equal(relations.get("ACS-WORK-ITEM-DRAFT")?.activeWorkItems.length, 0);
});

test("operator snapshot retains work item backing semantics for artifact-backed sessions", async () => {
  const now = Date.now();
  const sessionKey = `agent:reviewer:surface-semantics:${now}`;

  try {
    rememberTrackingState(sessionKey, {
      sessionKey,
      agentId: "reviewer",
      status: "running",
      startMs: now - 2000,
      artifactContext: {
        kind: "code_review",
        request: {
          instruction: "确认 operator snapshot 暴露 artifact-backed work item 语义",
          requestedAt: now - 2500,
        },
        protocol: {
          transport: "code_review.json",
          intentType: "request_review",
        },
      },
    });

    const snapshot = await buildOperatorSnapshot({ listLimit: 10 });
    const item = snapshot.workItems.active.find((entry) => entry?.id === `artifact:code_review:${sessionKey}`);

    assert.ok(item, "expected artifact-backed work item in operator snapshot");
    assert.equal(item?.workItemKind, "artifact_backed");
    assert.equal(item?.taskType, "request_review");
  } finally {
    clearTrackingStore();
  }
});
