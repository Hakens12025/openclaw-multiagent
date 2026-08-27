import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

import { recordErrorPattern } from "../lib/error-ledger.js";
import {
  attachAdminChangeSetVerification,
  getAdminChangeSetDetails,
  recordAdminChangeSetExecution,
  saveAdminChangeSetDraft,
} from "../lib/admin/change-sets/admin-change-sets.js";
import { CONTROL_PLANE_PATHS } from "../lib/control-plane/control-plane-paths.js";

const OC = join(homedir(), ".openclaw");
const ERROR_LEDGER_FILE = join(OC, "extensions", "watchdog", "data", "error-ledger.json");
const ADMIN_CHANGE_SET_DIR = CONTROL_PLANE_PATHS.adminChangeSetsDir;
const TEST_REPORTS_DIR = join(OC, "test-reports");

function getPatternCount(ledger, errorType) {
  return ledger.patterns.find((entry) => entry.errorType === errorType)?.count || 0;
}

test("error ledger preserves sibling error records under concurrent writes", async () => {
  const before = JSON.parse(await readFile(ERROR_LEDGER_FILE, "utf8").catch(() => JSON.stringify({ patterns: [] })));
  const beforeTimeout = getPatternCount(before, "timeout");
  const beforeFileNotFound = getPatternCount(before, "file_not_found");
  const logger = { info() {}, warn() {} };

  await Promise.all([
    recordErrorPattern({
      error: `timeout exceeded ${Date.now()}`,
      agentId: "error-ledger-a",
      trackingState: { contract: { task: "timeout task" }, toolCalls: [] },
      logger,
    }),
    recordErrorPattern({
      error: `ENOENT no such file ${Date.now()}`,
      agentId: "error-ledger-b",
      trackingState: { contract: { task: "missing file task" }, toolCalls: [] },
      logger,
    }),
  ]);

  const after = JSON.parse(await readFile(ERROR_LEDGER_FILE, "utf8"));
  assert.equal(getPatternCount(after, "timeout"), beforeTimeout + 1);
  assert.equal(getPatternCount(after, "file_not_found"), beforeFileNotFound + 1);
});

test("admin change set draft save resolves capability registry through canonical path", async () => {
  const draft = await saveAdminChangeSetDraft({
    surfaceId: "work_items.list",
    title: `runtime stability draft ${Date.now()}`,
  });

  try {
    assert.ok(draft?.id);
    assert.equal(draft.surfaceId, "work_items.list");
  } finally {
    if (draft?.id) {
      await rm(join(ADMIN_CHANGE_SET_DIR, `${draft.id}.json`), { force: true });
    }
  }
});

test("admin change set preserves verification and execution history under concurrent writes", async () => {
  const draft = await saveAdminChangeSetDraft({
    surfaceId: "work_items.list",
    title: `runtime stability concurrent draft ${Date.now()}`,
  });
  const reportPath = join(TEST_REPORTS_DIR, `${draft.id}.json`);

  try {
    // test-reports/ 是运行产物目录(gitignore),全新 checkout(CI)缺席 → 先保证存在。
    await mkdir(TEST_REPORTS_DIR, { recursive: true });
    await writeFile(reportPath, JSON.stringify({
      id: `RUN-${draft.id}`,
      status: "completed",
      totalCases: 1,
      completedCases: 1,
      passedCases: 1,
      failedCases: 0,
      blockedCases: 0,
      caseResults: [{ id: "case-1", pass: true }],
    }, null, 2));

    await Promise.all([
      attachAdminChangeSetVerification({
        id: draft.id,
        reportPath,
        note: "verify",
      }),
      recordAdminChangeSetExecution({
        id: draft.id,
        status: "completed",
        note: "exec",
        payload: {},
        result: { ok: true },
      }),
    ]);

    const next = await getAdminChangeSetDetails(draft.id);
    assert.equal(next?.verificationHistory?.length || 0, 1);
    assert.equal(next?.executionHistory?.length || 0, 1);
  } finally {
    await rm(reportPath, { force: true });
    await rm(join(ADMIN_CHANGE_SET_DIR, `${draft.id}.json`), { force: true });
  }
});
