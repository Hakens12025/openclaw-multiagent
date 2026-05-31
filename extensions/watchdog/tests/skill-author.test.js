import test from "node:test";
import assert from "node:assert/strict";
import { readFile, rm, access } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

import { createSkillDefinition, authorSkillSurface } from "../lib/admin/skill-author.js";

const SKILLS_DIR = join(homedir(), ".openclaw", "skills");

test("createSkillDefinition writes a valid SKILL.md with frontmatter (new skill)", async () => {
  const id = `sc-skill-test-${process.pid}`;
  const dir = join(SKILLS_DIR, id);
  try {
    const res = await createSkillDefinition({
      skillId: id,
      description: "self-check test skill",
      body: "# Test Skill\n\nbody content here.",
    });
    assert.equal(res.ok, true);
    assert.equal(res.skillId, id);
    const content = await readFile(res.path, "utf8");
    assert.match(content, new RegExp(`name: ${id}`));
    assert.match(content, /description: self-check test skill/);
    assert.match(content, /body content here/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("createSkillDefinition is new-only: refuses to clobber an existing skill (protects builtins)", async () => {
  // platform-tools is a shipped builtin — must NOT be overwritten
  const res = await createSkillDefinition({ skillId: "platform-tools", description: "x", body: "y" });
  assert.equal(res.ok, false);
  assert.match(res.error, /already exists/);
  // and the builtin file is untouched
  await access(join(SKILLS_DIR, "platform-tools", "SKILL.md")); // throws if missing → test fails
});

test("createSkillDefinition rejects unsafe ids (path traversal / casing / empty)", async () => {
  await assert.rejects(() => createSkillDefinition({ skillId: "../etc/passwd", description: "d" }), /invalid skillId/);
  await assert.rejects(() => createSkillDefinition({ skillId: "Bad_Caps", description: "d" }), /invalid skillId/);
  await assert.rejects(() => createSkillDefinition({ skillId: "a/b", description: "d" }), /invalid skillId/);
  await assert.rejects(() => createSkillDefinition({ skillId: "", description: "d" }), /invalid skillId/);
});

test("createSkillDefinition requires a description", async () => {
  await assert.rejects(() => createSkillDefinition({ skillId: `sc-nodesc-${process.pid}`, body: "x" }), /requires a description/);
});

test("authorSkillSurface maps payload fields (skillId/id/name + body/content)", async () => {
  const id = `sc-surface-test-${process.pid}`;
  const dir = join(SKILLS_DIR, id);
  try {
    const res = await authorSkillSurface({ payload: { name: id, description: "via surface", content: "surface body" }, logger: { info() {} } });
    assert.equal(res.ok, true);
    const content = await readFile(res.path, "utf8");
    assert.match(content, /via surface/);
    assert.match(content, /surface body/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
