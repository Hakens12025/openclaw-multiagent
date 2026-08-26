import { normalizeRecord, normalizeString } from "../../core/normalize.js";

// P3 强制 verify 门（代码硬路径，写死在 commit 流程）。
//
// 契约：apply-stage 且 verificationCapability.supported 的 ChangeSet，
// 在 commit-to-applied 之前必须已有一条 "passed" 的 verification 记录
// （由 attach_verification 经既有 verificationHistory 字段链落入，从 test-run
//  /report 实际产物读 pass/fail，见 admin-change-set-verification.js）。
// 门只校验既有 verify 真值，不在 commit 里现跑测试（避免长跑 flaky），
// 也不造第二套字段——复用 lastVerificationStatus / verificationHistory。
//
// verify 四问由既有链路回答：
//   验什么     -> verificationCapability（surface 声明）
//   证据从哪   -> resolveVerificationRun 读 test-run/report 产物的 caseResults
//   成功标准   -> normalizeVerificationStatus（failedCases>0 -> failed,
//                completed + totalCases>0 -> passed）
//   失败如何归因 -> verificationHistory[].failedCaseIds / blockedCaseIds

const VERIFY_PASSED = "passed";

export function isVerificationRequiredForCommit({ preview, requireVerification = true } = {}) {
  if (requireVerification !== true) return false;
  const capability = normalizeRecord(preview?.verificationCapability);
  return capability.supported === true;
}

// 返回门裁定。passed=true 才允许 commit-to-applied。
export function evaluateCommitVerificationGate({ draft, preview, requireVerification = true } = {}) {
  const required = isVerificationRequiredForCommit({ preview, requireVerification });
  const lastVerificationStatus = normalizeString(draft?.lastVerificationStatus) || null;
  const passed = lastVerificationStatus === VERIFY_PASSED;

  if (!required) {
    return { required: false, passed: true, lastVerificationStatus };
  }

  if (passed) {
    return {
      required: true,
      passed: true,
      lastVerificationStatus,
      lastVerificationRunId: normalizeString(draft?.lastVerificationRunId) || null,
    };
  }

  // 失败归因：从既有 verificationHistory 取最近一条的失败用例。
  const latest = Array.isArray(draft?.verificationHistory) ? draft.verificationHistory[0] : null;
  return {
    required: true,
    passed: false,
    lastVerificationStatus: lastVerificationStatus || "missing",
    failedCaseIds: Array.isArray(latest?.failedCaseIds) ? latest.failedCaseIds : [],
    blockedCaseIds: Array.isArray(latest?.blockedCaseIds) ? latest.blockedCaseIds : [],
    reason: lastVerificationStatus
      ? `verification not passed (${lastVerificationStatus})`
      : "no passing verification on record",
  };
}

// 门未通过时抛出的错误（让 commit-to-applied 硬失败，而非静默落 applied）。
export class CommitVerificationBlockedError extends Error {
  constructor(surfaceId, gate) {
    super(`commit blocked: verification gate not passed for ${surfaceId}: ${gate.reason}`);
    this.name = "CommitVerificationBlockedError";
    this.surfaceId = surfaceId;
    this.gate = gate;
  }
}
