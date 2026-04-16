// lib/hard-path-autoexec.js — worker-side hard-path experiment auto execution

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { agentWorkspace } from "./state.js";
import { cacheContractSnapshot } from "./store/contract-store.js";
import { persistContractSnapshot } from "./contracts.js";
import { CONTRACT_STATUS } from "./core/runtime-status.js";

function getExperimentLabel(contract) {
  return contract.experimentSpec?.experiment_id || contract.experimentSpec?.experimentId || contract.id;
}

export async function runWorkerHardPathAutoExec({ agentId, trackingState, logger }) {
  if (!trackingState?.contract) return false;

  const ws = agentWorkspace(agentId);
  const inboxContract = join(ws, "inbox", "contract.json");

  try {
    const raw = await readFile(inboxContract, "utf8");
    const contract = JSON.parse(raw);
    if (!contract._hardPath?.command) return false;

    const hardPathMeta = {
      ranAt: Date.now(),
      command: contract._hardPath.command,
      specPath: contract._hardPath.specPath || null,
      outputDir: contract._hardPath.outputDir || null,
    };

    logger.info(`[watchdog] EXPERIMENT AUTO-EXEC: running ${contract._hardPath.command.slice(0, 80)}...`);

    try {
      execSync(contract._hardPath.command, { timeout: 120000, stdio: "pipe" });
      logger.info(`[watchdog] EXPERIMENT AUTO-EXEC: success for ${contract.id}`);
      contract._hardPathResult = { ...hardPathMeta, status: CONTRACT_STATUS.COMPLETED };
      contract.task = `${getExperimentLabel(contract)} 已由系统自动执行完成。\n请读取 output 路径中的结果文件，将关键结论写入输出。`;
    } catch (execErr) {
      logger.warn(`[watchdog] EXPERIMENT AUTO-EXEC: failed for ${contract.id}: ${execErr.message}`);
      contract._hardPathResult = {
        ...hardPathMeta,
        status: CONTRACT_STATUS.FAILED,
        error: execErr.message.slice(0, 500),
      };
      contract.task = `${getExperimentLabel(contract)} 自动执行失败。\n错误: ${execErr.message.slice(0, 200)}\n请将此错误信息写入 output 路径。`;
    }

    delete contract._hardPath;
    trackingState.contract.task = contract.task;
    trackingState.contract._hardPathResult = contract._hardPathResult;
    delete trackingState.contract._hardPath;

    await writeFile(inboxContract, JSON.stringify(contract, null, 2));
    cacheContractSnapshot(inboxContract, contract);
    if (trackingState.contract.path) {
      await persistContractSnapshot(trackingState.contract.path, contract, logger, { touchUpdatedAt: true });
    }
    return true;
  } catch {
    return false;
  }
}
