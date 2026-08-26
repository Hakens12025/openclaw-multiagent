// lib/core/config-check.js — cfg 边界校验（RX-03）。校验不过即抛,插件拒绝带病加载。
// 只校验类型与范围;空字符串合法(是否必填是部署策略,不在类型层裁决)。
const CFG_RULES = Object.freeze({
  hooksToken: "string",
  qqAppId: "string",
  qqClientSecret: "string",
  gatewayToken: "string",
  gatewayPort: "port",
  agentTimeout: "positiveInt",
});

export function validateCfgAssignment(candidate) {
  const errors = [];
  for (const [key, rule] of Object.entries(CFG_RULES)) {
    const value = candidate[key];
    if (rule === "string" && typeof value !== "string") {
      errors.push(`${key}: expected string, got ${typeof value}`);
    } else if (rule === "port" && (!Number.isInteger(value) || value < 1 || value > 65535)) {
      errors.push(`${key}: expected integer port 1-65535, got ${JSON.stringify(value)}`);
    } else if (rule === "positiveInt" && (!Number.isInteger(value) || value <= 0)) {
      errors.push(`${key}: expected positive integer (ms), got ${JSON.stringify(value)}`);
    }
  }
  const unknown = Object.keys(candidate).filter((k) => !(k in CFG_RULES));
  if (unknown.length) errors.push(`unknown keys: ${unknown.join(", ")}`);
  if (errors.length) {
    throw new Error(`[E-CONFIG-003] watchdog cfg invalid:\n${errors.map((e) => `  - ${e}`).join("\n")}`);
  }
  return candidate;
}
