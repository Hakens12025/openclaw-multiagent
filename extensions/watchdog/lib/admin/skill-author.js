// skill-author.js — skills.create surface: operator authors a new skill (SKILL.md) via CLI-system.
// Validate id + frontmatter, write ~/.openclaw/skills/<id>/SKILL.md. "create" = new only — refuses
// to clobber an existing skill (protects platform builtins). The framework loads the skill by name
// when an agent references it (agents.skills surface); authoring does NOT auto-inject it anywhere.

import { mkdir, access } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

import { normalizeString } from "../core/normalize.js";
import { atomicWriteFile } from "../state.js";

const SKILLS_DIR = join(homedir(), ".openclaw", "skills");
// kebab-case slug, no path traversal, bounded length.
const SKILL_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,48}$/;

export async function createSkillDefinition({ skillId, description, body } = {}) {
  const id = normalizeString(skillId);
  if (!id || !SKILL_ID_PATTERN.test(id)) {
    throw new Error(`skills.create: invalid skillId (need kebab-case ^[a-z0-9][a-z0-9-]{1,48}$): ${skillId}`);
  }
  const desc = normalizeString(description);
  if (!desc) {
    throw new Error("skills.create requires a description (used as SKILL.md frontmatter)");
  }
  const content = typeof body === "string" ? body : "";
  const dir = join(SKILLS_DIR, id);
  const file = join(dir, "SKILL.md");

  let exists = false;
  try { await access(file); exists = true; } catch {}
  if (exists) {
    return { ok: false, error: `skill already exists: ${id} (create is new-only; protects builtins)`, skillId: id };
  }

  const md = `---\nname: ${id}\ndescription: ${desc}\n---\n\n${content.trim()}\n`;
  await mkdir(dir, { recursive: true });
  await atomicWriteFile(file, md);
  return { ok: true, skillId: id, path: file, bytes: Buffer.byteLength(md, "utf8") };
}

export async function authorSkillSurface({ payload, logger } = {}) {
  const p = payload && typeof payload === "object" ? payload : {};
  const result = await createSkillDefinition({
    skillId: p.skillId ?? p.id ?? p.name,
    description: p.description,
    body: p.body ?? p.content,
  });
  if (result.ok) {
    logger?.info?.(`[watchdog] skill authored: ${result.skillId} → ${result.path} (${result.bytes}B)`);
  }
  return result;
}
