// lib/formal-test-presets.js — formal preset 单一真值源（CheckResult 体系，8 个预设）
//
// 每个 preset 对应一个 suite 驱动（lib/formal-runtime/suite-*.js），suite 产出
// CheckResult（lib/formal-runtime/checks/check-runner.js），报告由 formal-report.js 渲染。
// caseIds 语义因 suite 而异：
//   - health/full：描述性分组 id（suite 不做 per-case 过滤）
//   - dispatch/pipeline/system-action：真实 case id（dispatch/pipeline 支持 --case 子集）
//   - loop/operator/knowledge：自寻靶（graph/registry/fixture 真值），无 case 概念
// cleanMode:"none" = 只读/自恢复 suite，运行前后都不做 fullReset（reset 本身会留下
// 体检要捕捉的残留）；"session-clean" = 运行前后 fullReset。

const FORMAL_PRESET_DEFS = [
  {
    id: "health",
    label: "系统健康体检",
    description: "零 LLM 体检：TIER-0 进程内（配置/注册表/graph完整性/loop预算/模型链/marker）+ TIER-1 live gateway（auth/inspect 全面扫/SSE/confirm 闸/守护式 mutation 往返）",
    suite: "health",
    family: "health",
    runtimeMode: "static",
    transport: "none",
    cleanMode: "none",
    caseIds: ["health-node", "health-gateway"],
    resetBetweenCases: false,
  },
  {
    id: "dispatch",
    label: "链路单点",
    description: "live inject → contract terminal → output mirror（2 个最小派工用例）",
    suite: "dispatch",
    family: "live",
    runtimeMode: "live",
    transport: "isolated",
    cleanMode: "session-clean",
    caseIds: ["answer-direct", "small-file-task"],
    resetBetweenCases: false,
  },
  {
    id: "pipeline",
    label: "多跳流水线",
    description: "planner 简报 → executor 交付物 + upstream 产物包流转（2 个多跳用例）",
    suite: "pipeline",
    family: "live",
    runtimeMode: "live",
    transport: "isolated",
    cleanMode: "session-clean",
    caseIds: ["brief-to-deliverable", "research-summary"],
    resetBetweenCases: false,
  },
  {
    id: "loop",
    label: "回路收敛",
    description: "compose(maxRounds:1) → start → 预算收敛 → delete；graph 无环时 E-LOOP-SKIP",
    suite: "loop",
    family: "live",
    runtimeMode: "live",
    transport: "isolated",
    cleanMode: "session-clean",
    caseIds: [],
    resetBetweenCases: false,
  },
  {
    id: "system-action",
    label: "系统动作探针",
    description: "[ACTION] create_task/assign_task/request_review 三探针，SSE checkpoint 链逐点判定",
    suite: "system-action",
    family: "live",
    runtimeMode: "live",
    transport: "runtime",
    cleanMode: "session-clean",
    caseIds: ["create-task", "assign-task", "request-review"],
    resetBetweenCases: true,
  },
  {
    id: "operator",
    label: "operator 闭环",
    description: "预览/手写 plan apply/强制 verify 门/快照回滚/所有权与确认负探针 + 可选 LLM plan（skip 门控）",
    suite: "operator",
    family: "gateway",
    runtimeMode: "deterministic",
    transport: "isolated",
    cleanMode: "none",
    caseIds: [],
    resetBetweenCases: false,
  },
  {
    id: "knowledge",
    label: "知识库召回",
    description: "EMBED 门控：已知良命中 + 24 例 recall 地板（@10>=0.85/@5>=0.65/MRR>=0.5）",
    suite: "knowledge",
    family: "embed",
    runtimeMode: "deterministic",
    transport: "isolated",
    cleanMode: "none",
    caseIds: [],
    resetBetweenCases: false,
  },
  {
    id: "full",
    label: "全量体检",
    description: "全部 7 个 suite 串行（health→dispatch→pipeline→loop→system-action→operator→knowledge），CheckResult 汇总进一份报告",
    suite: "full",
    family: "full",
    runtimeMode: "live",
    transport: "runtime",
    cleanMode: "session-clean",
    caseIds: ["health", "dispatch", "pipeline", "loop", "system-action", "operator", "knowledge"],
    resetBetweenCases: false,
  },
];

export const FORMAL_TEST_PRESETS = Object.freeze(
  FORMAL_PRESET_DEFS.map((preset) => Object.freeze({
    ...preset,
    caseIds: Object.freeze([...preset.caseIds]),
  })),
);

const FORMAL_PRESET_MAP = new Map(FORMAL_TEST_PRESETS.map((preset) => [preset.id, preset]));

export function listFormalTestPresets() {
  return FORMAL_TEST_PRESETS.map((preset) => ({
    ...preset,
    caseIds: [...preset.caseIds],
  }));
}

export function getFormalPresetById(presetId) {
  const preset = FORMAL_PRESET_MAP.get(String(presetId || "").trim());
  return preset
    ? {
        ...preset,
        caseIds: [...preset.caseIds],
      }
    : null;
}
