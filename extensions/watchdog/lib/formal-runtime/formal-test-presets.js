// lib/formal-runtime/formal-test-presets.js — formal preset 单一真值源（CheckResult 体系）
//
// 每个 preset 对应一个 suite 驱动（lib/formal-runtime/suite-*.js），suite 产出
// CheckResult（lib/formal-runtime/checks/check-runner.js），报告由 formal-report.js 渲染。
// caseIds 语义因 suite 而异：
//   - health/full：描述性分组 id（suite 不做 per-case 过滤）
//   - single/pipeline/collab/concurrent：真实 case id（single/pipeline 支持 --case 子集）
//   - operator/knowledge/model/unit：自寻靶（graph/registry/fixture/config 真值），无 case 概念
// cleanMode:"none" = 只读/自恢复 suite，运行前后都不做 fullReset（reset 本身会留下
// 体检要捕捉的残留）；"session-clean" = 运行前后 fullReset。

const FORMAL_PRESET_DEFS = [
  {
    id: "health",
    label: "系统健康体检",
    description: "零 LLM 体检：TIER-0 进程内（配置/注册表/graph完整性/模型链/marker）+ TIER-1 live gateway（auth/inspect 全面扫/SSE/confirm 闸/守护式 mutation 往返）",
    suite: "health",
    family: "health",
    runtimeMode: "static",
    transport: "none",
    cleanMode: "none",
    caseIds: ["health-node", "health-gateway"],
    resetBetweenCases: false,
  },
  {
    id: "model",
    label: "模型全链路",
    description: "对每个有凭证 provider 两步判定：① 裸 API 多格式连通（吸收原 providers 套件：远端不通→fail E-MODEL-004，本地离线→skip）② 全链路实例：临时 executor agent（model-probe-<slug>）挂该模型→直派极简写文件任务→合约终态且交付物含 MODEL_OK（否则 E-MODEL-005；agent 建/删失败 E-MODEL-006）。串行逐模型，每模型 e2e 预算 180s；出生门:动态 agent 25s 内未诞生会话→e2e 转 skip(宿主花名册启动时固定)",
    suite: "model",
    family: "live",
    runtimeMode: "live",
    transport: "runtime",
    cleanMode: "session-clean",
    caseIds: [],
    resetBetweenCases: false,
  },
  {
    id: "single",
    label: "链路单点",
    description: "live inject → contract terminal → output mirror（2 个最小派工用例）",
    suite: "single",
    family: "live",
    runtimeMode: "live",
    transport: "isolated",
    cleanMode: "session-clean",
    caseIds: ["answer-direct", "small-file-task"],
    resetBetweenCases: false,
  },
  {
    id: "concurrent",
    label: "并发派工竞态",
    description: "同一 caller 并发注入(3 连注 + 5 连发):受理创建、忙位唯一(1 running 其余 queued)、FIFO 激活序、无双绑(同一合约不被两个会话认领)、全终态与释放对账",
    suite: "concurrent",
    contractBudget: 14, // 合法注入 8 + 余量(哨兵默认 10 会误杀)
    family: "live",
    runtimeMode: "live",
    transport: "runtime",
    cleanMode: "session-clean",
    caseIds: ["conc-same-3", "conc-burst-5"],
    resetBetweenCases: true,
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
    id: "collab",
    label: "系统动作探针",
    description: "三层化探针:L1 工具(assign/review+期望声明)+L3 标记(review)+known-but-denied(create_task),合约会话 SSE checkpoint 链逐点判定",
    suite: "collab",
    contractBudget: 16, // 实测合法就造 10 个(6 TC 探针 + 4 探针 assign 的 DIRECT),默认 10 零余量会误杀
    family: "live",
    runtimeMode: "live",
    transport: "runtime",
    cleanMode: "session-clean",
    caseIds: ["l1-assign-toolface", "l1-assign-expectations", "l1-review-toolface", "l3-marker-review", "create-task-denied"],
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
    id: "viz",
    label: "viz-master 可视化",
    description: "确定性零 LLM：经 viz-master executor 真跑 apply.chart_create（静态图 + sse 实时绑定图）→ inspect.charts 往返 → 非法 spec 被拒 → delete 清理。测第 2 meta-agent 的可视化产出管道",
    suite: "viz",
    family: "gateway",
    runtimeMode: "deterministic",
    transport: "isolated",
    cleanMode: "none",
    caseIds: [],
    resetBetweenCases: false,
  },
  {
    id: "group",
    label: "AgentGroup 空间原语",
    description: "确定性红线（normalizeGroupSpec 拒 <2成员/非法outputMode/缺id + 丢非成员内部边=无授权暗门）+ 宏展开契约 + 一次 live graph.group.compose→inspect.agent_groups→rollback→prune 清理",
    suite: "group",
    family: "gateway",
    runtimeMode: "deterministic",
    transport: "isolated",
    cleanMode: "none",
    caseIds: [],
    resetBetweenCases: false,
  },
  {
    id: "unit",
    label: "单测全量",
    description: "spawn npm test（node --test 全部 tests/*.test.js，600s 硬超时）→ 解析尾部 totals 产出汇总 CheckResult（失败列 ✖ 用例名，skip>0 补环境门注记）；隔离由店根门卫承担（control-plane-paths §13：node --test 子进程店根结构性落沙箱，图快照护栏 2026-08-26 随之退役）",
    suite: "unit",
    family: "health",
    runtimeMode: "static",
    transport: "none",
    cleanMode: "none",
    caseIds: [],
    resetBetweenCases: false,
  },
  {
    id: "full",
    label: "全量体检",
    description: "全部 11 个 suite 串行（health→model→single→concurrent→pipeline→collab→operator→knowledge→viz→group→unit），CheckResult 汇总进一份报告",
    suite: "full",
    contractBudget: 40, // 11 段合法合约实测约 25(single2+concurrent8+pipeline2+collab10+model~3),×1.6 余量
    family: "full",
    runtimeMode: "live",
    transport: "runtime",
    cleanMode: "session-clean",
    caseIds: ["health", "model", "single", "concurrent", "pipeline", "collab", "operator", "knowledge", "viz", "group", "unit"],
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
