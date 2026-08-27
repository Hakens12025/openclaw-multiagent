import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { SYSTEM_BLOCKS } from "../lib/dev/system-block-registry.js";

const OPENCLAW_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

async function readOpenClawFile(...parts) {
  return readFile(join(OPENCLAW_ROOT, ...parts), "utf8");
}

test("root development entry docs require primary System Block before code changes", async () => {
  // CODEX.md 私有策展、AGENTS.md 运行时生成:公开树缺席=剔除;在场照常全力。
  const readOptional = async (name) => {
    try {
      return await readOpenClawFile(name);
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  };
  const files = Object.fromEntries(Object.entries({
    claude: await readOpenClawFile("CLAUDE.md"),
    codex: await readOptional("CODEX.md"),
    agents: await readOptional("AGENTS.md"),
    systemMap: await readOpenClawFile("SYSTEM_MAP.md"),
  }).filter(([, content]) => content !== null));

  for (const [label, content] of Object.entries(files)) {
    assert.match(content, /System Blocks|System Block|system-blocks\.md/, `${label} must point to System Blocks`);
  }

  assert.match(files.claude, /primary System Block/i);
  if (files.codex) {
    assert.match(files.codex, /primary System Block/i);
    assert.match(files.codex, /openclaw-block-check\.js --primary <block-id>/);
  }
});

test("per-block handoff docs stay in sync with registry", async () => {
  for (const block of SYSTEM_BLOCKS) {
    const content = await readOpenClawFile("docs", "system-blocks", `${block.id}.md`);
    assert.match(content, new RegExp(`# ${escapeRegExp(block.title)}`));
    assert.match(content, new RegExp(`Block ID: \`${escapeRegExp(block.id)}\``));
    assert.match(content, new RegExp(`node scripts/openclaw-block-check\\.js --primary ${escapeRegExp(block.id)}`));
    for (const ownedTruth of block.ownedTruth) {
      assert.match(content, new RegExp(`- ${escapeRegExp(ownedTruth)}`), `${block.id} missing owned truth ${ownedTruth}`);
    }
    for (const minimalTest of block.minimalTests) {
      assert.match(content, new RegExp(`- \`${escapeRegExp(minimalTest)}\``), `${block.id} missing minimal test ${minimalTest}`);
    }
  }
});

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
