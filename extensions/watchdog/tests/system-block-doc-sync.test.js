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
  const files = {
    claude: await readOpenClawFile("CLAUDE.md"),
    codex: await readOpenClawFile("CODEX.md"),
    agents: await readOpenClawFile("AGENTS.md"),
    systemMap: await readOpenClawFile("SYSTEM_MAP.md"),
  };

  for (const [label, content] of Object.entries(files)) {
    assert.match(content, /System Blocks|System Block|system-blocks\.md/, `${label} must point to System Blocks`);
  }

  assert.match(files.claude, /primary System Block/i);
  assert.match(files.codex, /primary System Block/i);
  assert.match(files.codex, /openclaw-block-check\.js --primary <block-id>/);
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
