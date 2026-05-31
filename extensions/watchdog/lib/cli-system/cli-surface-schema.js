/**
 * CLISurface 正式字段契约（形式化 schema）。
 *
 * 此文件是 CLISurface 的权威字段定义，不改运行时行为，
 * 只做形式化校验。任何 surface 进入 registry 前必须通过此校验。
 */

const CLI_SURFACE_VALID_FAMILIES = Object.freeze([
  "hook",
  "observe",
  "inspect",
  "apply",
  "verify",
]);

const CLI_SURFACE_REQUIRED_FIELDS = Object.freeze([
  "id",
  "family",
  "source",
  "status",
]);

/**
 * 校验单个 CLISurface 对象是否符合正式字段契约。
 *
 * 必填字段：
 *   - id        {string}  唯一标识符，非空字符串
 *   - family    {string}  五类之一: hook | observe | inspect | apply | verify
 *   - source    {string}  非空字符串，表示 surface 来源
 *   - status    {string}  非空字符串，表示当前状态
 *
 * 可选字段（允许存在，无类型强制）：
 *   - risk, method, path, operatorExecutable, executable, summary,
 *     displayId, stage, subject, verificationCapability, operatorPhase,
 *     confirmation
 *
 * @param {unknown} surface
 * @returns {{ ok: boolean, problems: string[] }}
 */
export function validateCliSurface(surface) {
  const problems = [];

  if (!surface || typeof surface !== "object" || Array.isArray(surface)) {
    return { ok: false, problems: ["surface must be a plain object"] };
  }

  for (const field of CLI_SURFACE_REQUIRED_FIELDS) {
    const value = surface[field];
    if (value === null || value === undefined || value === "") {
      problems.push(`required field "${field}" is missing or empty`);
    } else if (typeof value !== "string") {
      problems.push(`required field "${field}" must be a string, got ${typeof value}`);
    }
  }

  if (typeof surface.family === "string" && surface.family !== "" && !CLI_SURFACE_VALID_FAMILIES.includes(surface.family)) {
    problems.push(
      `"family" must be one of [${CLI_SURFACE_VALID_FAMILIES.join(", ")}], got "${surface.family}"`,
    );
  }

  return { ok: problems.length === 0, problems };
}
