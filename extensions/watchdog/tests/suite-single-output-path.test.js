import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

mock.module("../lib/formal-runtime/infra.js", {
  namedExports: {
    PORT: 18789,
    OUTPUT_DIR: "/tmp/openclaw-output",
    fetchJSON: async () => [],
    sendViaBridge: async () => ({ ok: true }),
    sendTestInject: async () => ({ ok: true }),
    wakeAgentNow: async () => ({ ok: true }),
    postAdmin: async () => ({ ok: true }),
    sleep: async () => {},
  },
});

const {
  resolveValidationOutputPath,
  validateOutput,
} = await import("../lib/formal-runtime/suite-single.js");
const {
  getContractPath,
  persistContractSnapshot,
} = await import("../lib/contracts.js");

test("suite-single output validation follows runtime result artifact path before controller output fallback", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "openclaw-suite-single-"));
  const contractId = `TC-RUNTIME-OUTPUT-${Date.now()}`;
  const runtimeOutputPath = join(tempDir, "runtime-output.md");
  const contractPath = getContractPath(contractId);

  try {
    await writeFile(runtimeOutputPath, "hello runtime artifact\n", "utf8");
    await persistContractSnapshot(contractPath, {
      id: contractId,
      status: "completed",
      executionObservation: {
        primaryOutputPath: runtimeOutputPath,
      },
    });

    const resolvedPath = await resolveValidationOutputPath(contractId);
    assert.equal(resolvedPath, runtimeOutputPath);

    const validation = await validateOutput(contractId, {
      minBytes: 5,
    });
    assert.equal(validation.ok, true);
    assert.equal(validation.path, runtimeOutputPath);
  } finally {
    await rm(contractPath, { force: true });
    await rm(tempDir, { recursive: true, force: true });
  }
});
