import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { recordErrorPattern } from "../lib/error-ledger.js";
import { OC } from "../lib/state.js";

const ERROR_LEDGER_FILE = join(OC, "extensions", "watchdog", "data", "error-ledger.json");
const ERROR_SKILL_FILE = join(OC, "skills", "error-avoidance", "SKILL.md");

const logger = {
  info() {},
  warn() {},
};

async function readOptionalFile(filePath) {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

async function restoreOptionalFile(filePath, content) {
  if (content == null) {
    await rm(filePath, { force: true });
    return;
  }
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}

async function resetErrorLedger() {
  await rm(ERROR_LEDGER_FILE, { force: true });
  await rm(ERROR_SKILL_FILE, { force: true });
}

async function withIsolatedErrorLedger(fn) {
  const ledgerBackup = await readOptionalFile(ERROR_LEDGER_FILE);
  const skillBackup = await readOptionalFile(ERROR_SKILL_FILE);
  await resetErrorLedger();
  try {
    await fn();
  } finally {
    await restoreOptionalFile(ERROR_LEDGER_FILE, ledgerBackup);
    await restoreOptionalFile(ERROR_SKILL_FILE, skillBackup);
  }
}

function getPatternCount(ledger, errorType) {
  return ledger.patterns.find((entry) => entry.errorType === errorType)?.count || 0;
}

test("error ledger serializes concurrent sibling writes", async () => {
  await withIsolatedErrorLedger(async () => {
    await Promise.all([
      recordErrorPattern({
        error: "timeout exceeded during execution",
        agentId: "error-ledger-a",
        trackingState: { contract: { task: "timeout task" }, toolCalls: [] },
        logger,
      }),
      recordErrorPattern({
        error: "ENOENT no such file or directory",
        agentId: "error-ledger-b",
        trackingState: { contract: { task: "missing file task" }, toolCalls: [] },
        logger,
      }),
    ]);

    const ledger = JSON.parse(await readFile(ERROR_LEDGER_FILE, "utf8"));
    assert.equal(getPatternCount(ledger, "timeout"), 1);
    assert.equal(getPatternCount(ledger, "file_not_found"), 1);
  });
});

test("generated error avoidance skill uses minimal positive guidance", async () => {
  await withIsolatedErrorLedger(async () => {
    await recordErrorPattern({
      error: "permission denied",
      agentId: "error-ledger-agent",
      trackingState: {
        contract: { task: "permission task" },
        toolCalls: [{ tool: "read" }],
      },
      logger,
    });

    const skill = await readFile(ERROR_SKILL_FILE, "utf8");
    assert.match(skill, /^---\nname: error-avoidance\n/m);
    assert.doesNotMatch(skill, /不要|避免|禁止|不得/u);
    assert.match(skill, /配置和跨 workspace 操作交给 runtime\/operator/u);
  });
});
