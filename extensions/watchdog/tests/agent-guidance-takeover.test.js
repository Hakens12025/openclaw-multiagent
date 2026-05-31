import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  backupWorkspaceGuidanceFiles,
  pruneWorkspaceGuidanceBackups,
  GUIDANCE_BACKUP_RETENTION,
} from "../lib/agent/agent-guidance-backup.js";

async function makeWorkspaceWithFiles(files) {
  const dir = await mkdtemp(join(tmpdir(), "takeover-"));
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, name), content, "utf8");
  }
  return dir;
}

test("takeover backup copies workspace guidance files into .guidance-backup/<ts>/", async () => {
  const workspaceDir = await makeWorkspaceWithFiles({
    "SOUL.md": "# before",
    "HEARTBEAT.md": "hb",
  });
  const result = await backupWorkspaceGuidanceFiles({
    workspaceDir,
    fileNames: ["SOUL.md", "HEARTBEAT.md", "NONEXISTENT.md"],
  });
  assert.ok(result.backupDir, "backup dir should be created");
  assert.equal(result.backupPaths.length, 2, "only existing files are backed up");
  const soulCopy = await readFile(join(result.backupDir, "SOUL.md"), "utf8");
  assert.equal(soulCopy, "# before");
});

test("retention policy keeps only the latest 10 snapshots per agent", async () => {
  const workspaceDir = await makeWorkspaceWithFiles({
    "SOUL.md": "# seed",
  });
  // Fabricate 12 snapshot directories with sortable ISO-like names.
  const backupRoot = join(workspaceDir, ".guidance-backup");
  await mkdir(backupRoot, { recursive: true });
  const stamps = [];
  for (let i = 0; i < 12; i++) {
    const name = `2026-04-20T10-00-${String(i).padStart(2, "0")}`;
    stamps.push(name);
    await mkdir(join(backupRoot, name), { recursive: true });
    await writeFile(join(backupRoot, name, "SOUL.md"), `# snap-${i}`, "utf8");
  }
  const result = await pruneWorkspaceGuidanceBackups({ workspaceDir, keep: GUIDANCE_BACKUP_RETENTION });
  assert.equal(result.removed.length, 2, "oldest two snapshots removed");
  const remaining = (await readdir(backupRoot)).sort();
  assert.equal(remaining.length, 10);
  assert.equal(remaining[0], stamps[2], "oldest remaining snapshot is the 3rd");
});
