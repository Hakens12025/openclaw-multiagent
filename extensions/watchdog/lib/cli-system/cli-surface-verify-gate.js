import { executeCliSystemSurface } from "./cli-surface-registry.js";
import { getCliSystemSurface } from "./cli-surface-registry.js";
import { normalizeRecord, normalizeString } from "../core/normalize.js";

// ② 强制 verify 门（forceVerify after apply，代码硬路径）。
//
// 与 P3 互补、同一套机制的第二个插入点：
//   P3 (admin-change-set-commit-gate): admin-change-set **commit** 路径
//       —— commit-to-applied 前校验「已有 passed verification 记录」。
//   ② (本文件):                       operator **主动 apply** 路径
//       —— apply 成功后，若 surface 有 verificationCapability.supported，
//          强制经同一 verify surface (test_runs.start) 启动一道 verify 把改动验回来。
//
// 复用（不造第二套真值）：
//   - verificationCapability（admin-surface-registry:217 已对 apply surface 生成）
//   - verify surface test_runs.start（P3 注册，operatorExecutable）
//   - origin* 关联（runtimeContext.originSurfaceId → test-run，同 P3 链路）
//   - 结果状态语义同 normalizeVerificationStatus（started/running/failed_to_start）
//
// verify 四问：
//   验什么     -> surface.verificationCapability（surface 声明能否验、用哪个 preset）
//   证据从哪   -> 启动的 test-run（其 caseResults 经既有 summarizeVerificationRun 读，
//                由异步 test-run -> attach_verification 链路完成 pass/fail 收口，同 P3）
//   成功标准   -> verify run 完成且无 failedCases（normalizeVerificationStatus = passed）
//   失败归因   -> verify 起不来 = failed_to_start + error；run 失败 = 既有 failedCaseIds

const VERIFY_SURFACE_ID = "test_runs.start";

// surface 是否要求 apply 后强制 verify（有 capability.supported 即强制；无则豁免）。
export function isVerifyRequiredAfterApply(surfaceId, { forceVerify = true } = {}) {
  if (forceVerify !== true) return false;
  const surface = getCliSystemSurface(normalizeString(surfaceId));
  return normalizeRecord(surface?.verificationCapability).supported === true;
}

// apply 成功后焊上的 verify 门：强制启动一道 verify，返回 verify 记录。
// 不在此处同步等待长跑 test 结果（与 P3 一致，避免 flaky）；启动失败如实记 failed_to_start。
export async function runVerifyAfterApply({
  surfaceId,
  logger = null,
  onAlert = null,
  runtimeContext = null,
  forceVerify = true,
} = {}) {
  const normalizedSurfaceId = normalizeString(surfaceId);
  if (!isVerifyRequiredAfterApply(normalizedSurfaceId, { forceVerify })) {
    return { required: false, status: "exempt", surfaceId: normalizedSurfaceId };
  }

  const surface = getCliSystemSurface(normalizedSurfaceId);
  const capability = normalizeRecord(surface?.verificationCapability);
  const verifyContext = {
    ...normalizeRecord(runtimeContext),
    // origin 关联：把本次 apply 的 surface 作为 verify run 的 origin（同 P3 origin* 链路）。
    originSurfaceId: normalizedSurfaceId,
  };

  try {
    const result = await executeCliSystemSurface({
      surfaceId: VERIFY_SURFACE_ID,
      payload: {
        presetId: capability.presetId,
        cleanMode: capability.cleanMode,
      },
      actor: "operator",
      logger,
      onAlert,
      runtimeContext: verifyContext,
    });
    return {
      required: true,
      status: "started",
      surfaceId: normalizedSurfaceId,
      verifySurfaceId: VERIFY_SURFACE_ID,
      presetId: capability.presetId,
      cleanMode: capability.cleanMode,
      run: result?.run || null,
    };
  } catch (error) {
    // verify 起不来：如实记 failed_to_start（绝不放行成「已验证成功」）。
    return {
      required: true,
      status: "failed_to_start",
      surfaceId: normalizedSurfaceId,
      verifySurfaceId: VERIFY_SURFACE_ID,
      presetId: capability.presetId,
      cleanMode: capability.cleanMode,
      error: normalizeString(error?.message) || "verify failed to start",
    };
  }
}
