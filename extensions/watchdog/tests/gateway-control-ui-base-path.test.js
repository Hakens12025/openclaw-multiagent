import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(TEST_DIR, "../../..");
const CONFIG_PATH = path.join(PROJECT_ROOT, "openclaw.json");

test("gateway control UI is pinned to /ui so watchdog routes stay dedicated", async () => {
  const raw = await readFile(CONFIG_PATH, "utf8");
  const config = JSON.parse(raw);
  assert.equal(config?.gateway?.controlUi?.basePath, "/ui");
});
