import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { withLock } from "../../lib/state-file-utils.js";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForFile(filePath, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await readFile(filePath, "utf8");
      return;
    } catch {}
    await sleep(10);
  }
  throw new Error(`timeout waiting for file: ${filePath}`);
}

const [controlDir, lockKey, workerId] = process.argv.slice(2);
if (!controlDir || !lockKey || !workerId) {
  throw new Error("usage: node with-lock-child.js <controlDir> <lockKey> <workerId>");
}

const enteredFile = join(controlDir, `${workerId}.entered`);
const releaseFile = join(controlDir, `${workerId}.release`);
const doneFile = join(controlDir, `${workerId}.done`);
const stateFile = join(controlDir, "count.txt");

await withLock(lockKey, async () => {
  await writeFile(enteredFile, String(Date.now()), "utf8");
  await waitForFile(releaseFile);

  const raw = await readFile(stateFile, "utf8").catch(() => "0");
  const current = Number.parseInt(raw, 10) || 0;
  await sleep(50);
  await writeFile(stateFile, String(current + 1), "utf8");
  await writeFile(doneFile, "done", "utf8");
});
