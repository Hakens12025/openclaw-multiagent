// lib/hard-path-autoexec.js — worker-side hard-path experiment auto execution

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { exec } from "node:child_process";
import { agentWorkspace } from "./state.js";
import { cacheContractSnapshot } from "./store/contract-store.js";
import { persistContractSnapshot } from "./contracts.js";
import { CONTRACT_STATUS } from "./core/runtime-status.js";

// Shell metacharacters that could enable command injection
const SHELL_INJECTION_PATTERN = /[;&|`$()<>]/;

function validateHardPathCommand(command) {
  if (!command || typeof command !== "string") return false;
  if (SHELL_INJECTION_PATTERN.test(command)) return false;
  return true;
}

function execAsync(command, options) {
  return new Promise((resolve, reject) => {
    exec(command, { ...options, shell: false }, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve({ stdout, stderr });
    });
  });
}

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

    if (!validateHardPathCommand(contract._hardPath.command)) {
      logger.warn(`[watchdog] EXPERIMENT AUTO-EXEC: rejected unsafe command for ${contract.id}: ${contract._hardPath.command.slice(0, 80)}`);
      contract._hardPathResult = {
        ...hardPathMeta,
        status: CONTRACT_STATUS.FAILED,
        error: "Command rejected: contains shell metacharacters or is invalid.",
      };
      contract.task = `${getExperimentLabel(contract)} 自动执行被安全策略拒绝。\n命令包含不允许的 shell 元字符，请联系管理员。`;
    } else {
      logger.info(`[watchdog] EXPERIMENT AUTO-EXEC: running ${contract._hardPath.command.slice(0, 80)}...`);

      try {
        await execAsync(contract._hardPath.command, { timeout: 30000 });
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
