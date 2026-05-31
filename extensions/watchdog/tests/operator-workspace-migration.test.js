import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { migrateOperatorWorkspaceForPaths } from "../lib/agent/operator-workspace-migrate.js";

const tempRoot = await mkdtemp(join(tmpdir(), "openclaw-operator-workspace-"));
const legacyWorkspace = join(tempRoot, "workspaces", "platform-operator");
const operatorWorkspace = join(tempRoot, "workspaces", "operator");

test("operator workspace migration copies historical platform-operator files once", async () => {
  await rm(tempRoot, { recursive: true, force: true });
  await mkdir(legacyWorkspace, { recursive: true });
  await writeFile(join(legacyWorkspace, "SOUL.md"), "# legacy operator soul\n", "utf8");

  const first = await migrateOperatorWorkspaceForPaths({
    legacyWorkspace,
    operatorWorkspace,
    logger: null,
  });

  assert.equal(first.action, "copied");
  assert.equal(await readFile(join(operatorWorkspace, "SOUL.md"), "utf8"), "# legacy operator soul\n");

  await writeFile(join(operatorWorkspace, "SOUL.md"), "# canonical operator soul\n", "utf8");
  const second = await migrateOperatorWorkspaceForPaths({
    legacyWorkspace,
    operatorWorkspace,
    logger: null,
  });

  assert.equal(second.action, "already_exists");
  assert.equal(await readFile(join(operatorWorkspace, "SOUL.md"), "utf8"), "# canonical operator soul\n");
});

test.after(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});
