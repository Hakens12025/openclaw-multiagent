import test from "node:test";
import assert from "node:assert/strict";
import { lstat, mkdir, readlink, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { agentWorkspace } from "../lib/state.js";
import {
  canonicalizeContractOutputPath,
  ensureWorkspaceContractOutputAlias,
  resolveWorkspaceContractOutputAliasPath,
} from "../lib/runtime-contract-output-alias.js";
import { CONTROL_PLANE_PATHS } from "../lib/control-plane/control-plane-paths.js";

test("ensureWorkspaceContractOutputAlias creates a worker-local symlink for contract.output", async () => {
  const agentId = `worker-output-alias-${Date.now()}`;
  const workspaceDir = agentWorkspace(agentId);
  const contractOutput = join(CONTROL_PLANE_PATHS.outputDir, `TC-${Date.now()}.md`);
  const aliasPath = resolveWorkspaceContractOutputAliasPath(agentId, contractOutput);

  await mkdir(dirname(contractOutput), { recursive: true });

  try {
    const createdPath = await ensureWorkspaceContractOutputAlias({ agentId, contractOutput });
    const stats = await lstat(aliasPath);
    const linkTarget = await readlink(aliasPath);

    assert.equal(createdPath, aliasPath);
    assert.equal(stats.isSymbolicLink(), true);
    assert.equal(resolve(dirname(aliasPath), linkTarget), resolve(contractOutput));
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("canonicalizeContractOutputPath treats local output alias as the formal contract.output path", () => {
  const agentId = "contractor";
  const contractOutput = join(CONTROL_PLANE_PATHS.outputDir, "TC-alias.md");

  assert.equal(
    canonicalizeContractOutputPath({
      agentId,
      rawPath: "output/TC-alias.md",
      contractOutput,
    }),
    resolve(contractOutput),
  );

  assert.equal(
    canonicalizeContractOutputPath({
      agentId,
      rawPath: join(agentWorkspace(agentId), "output", "TC-alias.md"),
      contractOutput,
    }),
    resolve(contractOutput),
  );
});

test("ensureWorkspaceContractOutputAlias skips self-alias when contract.output already points at workspace output", async () => {
  const agentId = `worker-output-self-${Date.now()}`;
  const workspaceDir = agentWorkspace(agentId);
  const contractOutput = join(workspaceDir, "output", `DIRECT-${Date.now()}.md`);
  const aliasPath = resolveWorkspaceContractOutputAliasPath(agentId, contractOutput);

  try {
    const createdPath = await ensureWorkspaceContractOutputAlias({ agentId, contractOutput });

    await assert.rejects(lstat(aliasPath), { code: "ENOENT" });
    assert.equal(createdPath, aliasPath);
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});
