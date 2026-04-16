import { esc } from "./dashboard-common.js";
import { formatDateTime, getCurrentLang } from "./dashboard-i18n.js";

export const VIEW_MODES = Object.freeze({
  ATLAS: "atlas",
  PLACEMENT: "placement",
  RUNS: "runs",
  DRIFT: "drift",
});

const UI_COPY = {
  "zh-CN": {
    view_atlas: "塑形图谱",
    view_placement: "执行落点",
    view_runs: "运行轨迹",
    view_drift: "漂移图",
    placeholder_next: "后续",
    loading: "正在加载塑形套件看板...",
    load_failed: "加载失败",
    load_empty: "当前还没有可展示的塑形套件数据。",
    label_modules: "模块",
    label_profiles: "方案",
    label_families: "家族",
    label_automations: "自动化",
    label_pending: "待收敛",
    label_failing: "漂移",
    summary_modules: "执行层可拼装的塑形模块",
    summary_profiles: "可复用的塑形方案",
    summary_families: "塑形模块家族分类",
    summary_automations: "进入落点图的自动化目标",
    summary_pending: "本轮还在等待证据闭环",
    summary_failing: "守卫或闸门已出现漂移",
    family_atlas: "套件家族",
    all_families: "全部家族",
    all_families_meta: "全局总览",
    family_card_meta: "方案 {profiles} // 模块 {modules}",
    family_automations: "自动化 {count}",
    profile_library: "方案库",
    module_roster: "模块名录",
    placement_list: "自动化落点",
    placement_detail: "落点详情",
    runs_list: "轨迹目标",
    runs_detail: "轨迹详情",
    run_snapshot: "塑形截面",
    distribution_title: "塑形分布",
    distribution_profile_subtitle: "这套方案会把 agent 输出压进哪些固定形状，哪些地方只做语义引导，哪些区域明确留给 agent 自由发挥。",
    distribution_run_subtitle: "当前目标的塑形覆盖面。越偏左，说明越多执行路径被套件强行压入既定形状。",
    profile_focus_subtitle: "{family} 家族的塑形方案。你在这里能看到它会强压哪些执行环节、语义上要求哪些输出，以及明确留给 agent 自由发挥的区域。",
    no_profiles_in_family: "这个家族下还没有塑形方案。",
    no_modules_in_family: "当前筛选下没有匹配模块。",
    no_placement: "当前还没有自动化落点。",
    no_lane_items: "这个塑形道上还没有东西。",
    no_modules: "没有显式模块",
    no_hard_shaped_area: "没有硬塑形区域",
    lane_hard: "硬塑形",
    lane_soft: "软引导",
    lane_free: "自由发挥区",
    lane_hard_desc: "这里必须被塑形模块压住，并带有明确检查。",
    lane_soft_desc: "agent 可自由发挥，但交付语义必须朝目标收束。",
    lane_free_desc: "当前没有直接塑形模块压入，保留 agent 决策空间。",
    lane_ratio: "总占比 {percent}",
    section_modules: "模块清单",
    section_coverage: "塑形区域",
    tag_mode: "模式 {value}",
    tag_assurance: "保证 {value}",
    tag_usage: "使用中 {count}",
    tag_round: "轮次 {value}",
    label_usage: "使用量",
    label_assurance: "保证级别",
    label_families_count: "关联家族",
    label_profiles_count: "关联方案",
    label_runtime: "运行状态",
    label_profile: "方案",
    label_gate: "闸门结论",
    label_run_source: "取样来源",
    label_best_score: "最佳得分",
    label_recent_runs: "最近运行",
    label_started: "开始时间",
    label_finalized: "收口时间",
    label_decision: "决策",
    label_artifact: "产物",
    label_score: "分数",
    label_modules_total: "模块总数",
    label_modules_pending: "待收敛模块",
    label_modules_passed: "通过模块",
    label_modules_failed: "失败模块",
    label_modules_skipped: "跳过模块",
    label_pending_modules: "待收敛模块",
    label_failed_modules: "失败模块",
    label_contract: "合约",
    label_pipeline: "管线",
    label_loop: "回路",
    label_summary_text: "运行摘要",
    label_active_run: "当前运行",
    label_active_status: "当前状态",
    label_active_gate: "当前闸门",
    label_last_run: "最近一次",
    label_last_status: "最近状态",
    label_last_decision: "最近决策",
    label_target_agent: "目标 Agent",
    label_current_round: "当前轮次",
    label_best_score_short: "最佳得分",
    label_status: "状态",
    label_trust: "可信度",
    label_profile_count: "方案数",
    label_module_count: "模块数",
    label_run: "运行",
    stage_preflight: "预检",
    stage_dispatch: "派发",
    stage_in_run: "运行中",
    stage_completion: "完成门",
    stage_evaluation: "评估",
    stage_feedback: "反馈",
    kind_guard: "守卫",
    kind_collector: "采集器",
    kind_gate: "完成闸门",
    kind_normalizer: "标准化器",
    kind_module: "模块",
    mode_freeform: "自由模式",
    mode_hybrid: "混合塑形",
    mode_guarded: "强塑形",
    assurance_low_assurance: "低保证",
    assurance_medium_assurance: "中保证",
    assurance_high_assurance: "高保证",
    trust_stable: "稳定",
    trust_provisional: "暂定",
    trust_experimental: "实验",
    status_running: "运行中",
    status_idle: "空闲",
    status_paused: "暂停",
    status_completed: "已完成",
    status_stopped: "已停止",
    status_error: "错误",
    status_pending: "待收敛",
    status_passed: "通过",
    status_failed: "失败",
    status_skipped: "跳过",
    status_configured: "已配置",
    status_open: "开放",
    status_none: "无",
    run_source_active: "本轮运行",
    run_source_last: "最近一轮",
    run_source_recent: "历史记录",
    run_source_none: "无运行体",
    decision_continue: "继续",
    decision_complete: "完成",
    decision_stop: "停止",
    decision_retry: "重试",
    decision_hold: "挂起",
    decision_escalate: "升级",
    objective_meta: "{id} // 目标 {agent} // 领域 {domain}",
    placement_card_meta: "{id} // {agent}",
    focus_meta: "{family} // {mode}",
    runs_track_title: "轮次轨道",
    runs_track_subtitle: "按时间回看这条自动化被塑形套件压过的各轮运行。你能看到哪些轮次被强行收口，哪些轮次还停在闸门前。",
    runs_track_empty: "当前目标还没有可展示的塑形运行轨迹。",
    runs_only_empty: "当前还没有产生塑形运行记录的自动化。",
    run_card_round: "第 {value} 轮",
    run_card_round_fallback: "未编号轮次",
    drift_reserved_title: "漂移图 // 预留",
    drift_reserved_copy: "这里后面会展示守卫、闸门、实验打通状态在多轮运行中的漂移轨迹，让你直接看出哪些塑形套件开始失真。",
  },
  "en-US": {
    view_atlas: "ATLAS",
    view_placement: "PLACEMENT",
    view_runs: "RUNS",
    view_drift: "DRIFT",
    placeholder_next: "NEXT",
    loading: "Loading shaping suite dashboard...",
    load_failed: "Load Failed",
    load_empty: "No shaping suite data is available yet.",
    label_modules: "Modules",
    label_profiles: "Profiles",
    label_families: "Families",
    label_automations: "Automations",
    label_pending: "Pending",
    label_failing: "Drift",
    summary_modules: "Composable shaping modules on the execution layer",
    summary_profiles: "Reusable shaping profiles",
    summary_families: "Catalog families for shaping modules",
    summary_automations: "Automations visible in placement view",
    summary_pending: "Still waiting for evidence in this round",
    summary_failing: "A guard or gate has drifted",
    family_atlas: "Family Atlas",
    all_families: "All Families",
    all_families_meta: "global overview",
    family_card_meta: "profiles {profiles} // modules {modules}",
    family_automations: "automations {count}",
    profile_library: "Profile Library",
    module_roster: "Module Roster",
    placement_list: "Automation Placement",
    placement_detail: "Placement Detail",
    runs_list: "Run Targets",
    runs_detail: "Run Detail",
    run_snapshot: "Run Snapshot",
    distribution_title: "Shaping Distribution",
    distribution_profile_subtitle: "See what this profile force-shapes, what it only semantically guides, and what it intentionally leaves free for the agent.",
    distribution_run_subtitle: "Coverage for the current objective. The more it leans left, the more execution flow is physically shaped by the suite.",
    profile_focus_subtitle: "{family} profile family. This shows which execution segments get force-shaped, which outputs are semantically guided, and what remains freeform.",
    no_profiles_in_family: "No profile exists in this family yet.",
    no_modules_in_family: "No module matches the current filter.",
    no_placement: "No automation placement is available yet.",
    no_lane_items: "No item is placed in this lane.",
    no_modules: "no explicit modules",
    no_hard_shaped_area: "no hard-shaped area",
    lane_hard: "Hard-Shaped",
    lane_soft: "Soft-Guided",
    lane_free: "Freeform",
    lane_hard_desc: "This path must be force-shaped and explicitly checked.",
    lane_soft_desc: "The agent still has freedom, but output semantics must converge.",
    lane_free_desc: "No direct shaping module is applied here. Agent agency stays open.",
    lane_ratio: "share {percent}",
    section_modules: "Module List",
    section_coverage: "Coverage Areas",
    tag_mode: "mode {value}",
    tag_assurance: "assurance {value}",
    tag_usage: "used by {count}",
    tag_round: "round {value}",
    label_usage: "Usage",
    label_assurance: "Assurance",
    label_families_count: "Families",
    label_profiles_count: "Profiles",
    label_runtime: "Runtime",
    label_profile: "Profile",
    label_gate: "Gate",
    label_run_source: "Run Source",
    label_best_score: "Best Score",
    label_recent_runs: "Recent Runs",
    label_started: "Started",
    label_finalized: "Finalized",
    label_decision: "Decision",
    label_artifact: "Artifact",
    label_score: "Score",
    label_modules_total: "Module Total",
    label_modules_pending: "Pending Modules",
    label_modules_passed: "Passed Modules",
    label_modules_failed: "Failed Modules",
    label_modules_skipped: "Skipped Modules",
    label_pending_modules: "Pending Modules",
    label_failed_modules: "Failed Modules",
    label_contract: "Contract",
    label_pipeline: "Pipeline",
    label_loop: "Loop",
    label_summary_text: "Run Summary",
    label_active_run: "Active Run",
    label_active_status: "Active Status",
    label_active_gate: "Active Gate",
    label_last_run: "Last Run",
    label_last_status: "Last Status",
    label_last_decision: "Last Decision",
    label_target_agent: "Target Agent",
    label_current_round: "Current Round",
    label_best_score_short: "Best Score",
    label_status: "Status",
    label_trust: "Trust",
    label_profile_count: "Profiles",
    label_module_count: "Modules",
    label_run: "Run",
    stage_preflight: "Preflight",
    stage_dispatch: "Dispatch",
    stage_in_run: "In-Run",
    stage_completion: "Completion",
    stage_evaluation: "Evaluation",
    stage_feedback: "Feedback",
    kind_guard: "Guard",
    kind_collector: "Collector",
    kind_gate: "Gate",
    kind_normalizer: "Normalizer",
    kind_module: "Module",
    mode_freeform: "Freeform",
    mode_hybrid: "Hybrid",
    mode_guarded: "Guarded",
    assurance_low_assurance: "Low Assurance",
    assurance_medium_assurance: "Medium Assurance",
    assurance_high_assurance: "High Assurance",
    trust_stable: "Stable",
    trust_provisional: "Provisional",
    trust_experimental: "Experimental",
    status_running: "Running",
    status_idle: "Idle",
    status_paused: "Paused",
    status_completed: "Completed",
    status_stopped: "Stopped",
    status_error: "Error",
    status_pending: "Pending",
    status_passed: "Passed",
    status_failed: "Failed",
    status_skipped: "Skipped",
    status_configured: "Configured",
    status_open: "Open",
    status_none: "None",
    run_source_active: "Active Run",
    run_source_last: "Last Run",
    run_source_recent: "History",
    run_source_none: "No Run",
    decision_continue: "Continue",
    decision_complete: "Complete",
    decision_stop: "Stop",
    decision_retry: "Retry",
    decision_hold: "Hold",
    decision_escalate: "Escalate",
    objective_meta: "{id} // target {agent} // domain {domain}",
    placement_card_meta: "{id} // {agent}",
    focus_meta: "{family} // {mode}",
    runs_track_title: "Round Track",
    runs_track_subtitle: "Review the rounds this automation has been shaped through. You can see which rounds were tightly forced into form and which ones stalled at a gate.",
    runs_track_empty: "No shaping run is available for this automation yet.",
    runs_only_empty: "No automation has produced a shaping run yet.",
    run_card_round: "Round {value}",
    run_card_round_fallback: "Unnumbered Round",
    drift_reserved_title: "Drift // Reserved",
    drift_reserved_copy: "This will later show how guards, gates, and experiment continuity drift across rounds so distortion becomes visible immediately.",
  },
};

const FAMILY_LABELS = {
  coding: {
    "zh-CN": "编码",
    "en-US": "Coding",
  },
  experiment: {
    "zh-CN": "实验",
    "en-US": "Experiment",
  },
  evaluation: {
    "zh-CN": "评估",
    "en-US": "Evaluation",
  },
  general: {
    "zh-CN": "通用",
    "en-US": "General",
  },
};

function getLang() {
  return getCurrentLang() === "en-US" ? "en-US" : "zh-CN";
}

export function tx(key, params = null) {
  const lang = getLang();
  const packs = UI_COPY[lang] || UI_COPY["zh-CN"];
  let text = packs[key] ?? UI_COPY["zh-CN"][key] ?? key;
  if (params) {
    for (const [paramKey, paramValue] of Object.entries(params)) {
      text = text.replaceAll(`{${paramKey}}`, String(paramValue ?? ""));
    }
  }
  return text;
}

function humanize(value) {
  return String(value || "")
    .replace(/[._]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

export function formatCount(value) {
  return Number.isFinite(Number(value)) ? String(Number(value)) : "--";
}

export function formatValue(value) {
  if (value == null || value === "") return "--";
  return String(value);
}

export function formatPercent(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return "0%";
  return `${Math.round(numeric)}%`;
}

export function formatMode(value) {
  const normalized = String(value || "freeform").toLowerCase();
  return tx(`mode_${normalized}`);
}

export function formatAssurance(value) {
  const normalized = String(value || "low_assurance").toLowerCase();
  return tx(`assurance_${normalized}`);
}

export function formatTrust(value) {
  const normalized = String(value || "stable").toLowerCase();
  return tx(`trust_${normalized}`);
}

export function formatStatus(value, fallback = "none") {
  const normalized = String(value || fallback).toLowerCase();
  return tx(`status_${normalized}`);
}

export function formatDecision(value) {
  const normalized = String(value || "").toLowerCase();
  if (!normalized) return "--";
  const mapped = tx(`decision_${normalized}`);
  return mapped !== `decision_${normalized}` ? mapped : humanize(normalized);
}

export function formatRunSource(value) {
  const normalized = String(value || "none").toLowerCase();
  return tx(`run_source_${normalized}`);
}

export function formatTimestamp(value) {
  return value ? formatDateTime(value) : "--";
}

export function formatScore(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "--";
  if (Number.isInteger(numeric)) return String(numeric);
  return numeric.toFixed(3).replace(/\.?0+$/, "");
}

export function formatStageLabel(stageId, fallback = null) {
  const normalized = String(stageId || "").toLowerCase();
  return tx(`stage_${normalized}`) || fallback || humanize(stageId);
}

export function formatRoundLabel(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return tx("run_card_round_fallback");
  return tx("run_card_round", { value: String(numeric) });
}

export function parseHarnessModuleId(id) {
  const raw = String(id || "");
  const colonIdx = raw.indexOf(":");
  if (colonIdx < 0) return { prefix: null, kind: null, name: raw };
  const prefix = raw.slice(0, colonIdx);
  const rest = raw.slice(colonIdx + 1);
  const dotIdx = rest.indexOf(".");
  const kind = dotIdx >= 0 ? rest.slice(0, dotIdx) : rest;
  const name = dotIdx >= 0 ? rest.slice(dotIdx + 1) : "";
  return { prefix, kind, name };
}

export function formatModuleLabel(id) {
  const { kind, name } = parseHarnessModuleId(id);
  if (!kind) {
    // plain ID: humanize directly
    return String(id || "")
      .replace(/[._]+/g, " ")
      .trim()
      .replace(/\b\w/g, (m) => m.toUpperCase());
  }
  const displayName = (name || kind)
    .replace(/[._]+/g, " ")
    .trim()
    .replace(/\b\w/g, (m) => m.toUpperCase());
  return displayName;
}

export function formatKind(value) {
  const raw = String(value || "module").toLowerCase();
  const normalized = ["guard", "collector", "gate", "normalizer"].includes(raw)
    ? raw
    : "module";
  return tx(`kind_${normalized}`) || tx("kind_module");
}

export function formatFamilyLabel(value) {
  const normalized = String(value || "general").toLowerCase();
  const mapped = FAMILY_LABELS[normalized]?.[getLang()];
  return mapped || humanize(normalized);
}

export function formatTrustClass(value) {
  const normalized = String(value || "").toLowerCase();
  if (["stable", "provisional", "experimental"].includes(normalized)) {
    return `trust-${normalized}`;
  }
  return "";
}

export function formatKindClass(value) {
  const normalized = String(value || "").toLowerCase();
  return normalized ? `kind-${normalized}` : "";
}

export function formatStatusClass(value, fallback = "configured") {
  return String(value || fallback).toLowerCase();
}

function buildLaneCounts(countsSource = {}) {
  const hardShaped = Number(countsSource.hardShaped) || 0;
  const softGuided = Number(countsSource.softGuided) || 0;
  const freeform = Number(countsSource.freeform) || 0;
  const total = hardShaped + softGuided + freeform;
  return {
    hardShaped,
    softGuided,
    freeform,
    total,
  };
}

export function renderLaneMeter(countsSource, { subtitle = "" } = {}) {
  const counts = buildLaneCounts(countsSource);
  const total = counts.total || 1;
  const hardPercent = (counts.hardShaped / total) * 100;
  const softPercent = (counts.softGuided / total) * 100;
  const freePercent = (counts.freeform / total) * 100;

  return `
    <div class="harness-lane-meter">
      <div class="harness-lane-meter-head">
        <div>
          <div class="harness-lane-meter-title">${esc(tx("distribution_title"))}</div>
          <div class="harness-lane-meter-subtitle">${esc(subtitle)}</div>
        </div>
        <div class="harness-chip">${esc(formatCount(counts.total))}</div>
      </div>
      <div class="harness-lane-bar">
        <div class="harness-lane-fill hardShaped" style="width:${hardPercent}%"></div>
        <div class="harness-lane-fill softGuided" style="width:${softPercent}%"></div>
        <div class="harness-lane-fill freeform" style="width:${freePercent}%"></div>
      </div>
      <div class="harness-lane-breakdown">
        <div class="harness-lane-breakdown-item hardShaped">
          <span>${esc(tx("lane_hard"))}</span>
          <strong>${esc(formatCount(counts.hardShaped))}</strong>
          <small>${esc(tx("lane_ratio", { percent: formatPercent(hardPercent) }))}</small>
        </div>
        <div class="harness-lane-breakdown-item softGuided">
          <span>${esc(tx("lane_soft"))}</span>
          <strong>${esc(formatCount(counts.softGuided))}</strong>
          <small>${esc(tx("lane_ratio", { percent: formatPercent(softPercent) }))}</small>
        </div>
        <div class="harness-lane-breakdown-item freeform">
          <span>${esc(tx("lane_free"))}</span>
          <strong>${esc(formatCount(counts.freeform))}</strong>
          <small>${esc(tx("lane_ratio", { percent: formatPercent(freePercent) }))}</small>
        </div>
      </div>
    </div>
  `;
}

export function renderSummaryCards(counts = {}) {
  return `
    <div class="harness-summary-grid">
      <div class="harness-summary-card">
        <span class="harness-summary-label">${esc(tx("label_modules"))}</span>
        <strong>${esc(formatCount(counts.modules))}</strong>
        <small>${esc(tx("summary_modules"))}</small>
      </div>
      <div class="harness-summary-card">
        <span class="harness-summary-label">${esc(tx("label_profiles"))}</span>
        <strong>${esc(formatCount(counts.profiles))}</strong>
        <small>${esc(tx("summary_profiles"))}</small>
      </div>
      <div class="harness-summary-card">
        <span class="harness-summary-label">${esc(tx("label_families"))}</span>
        <strong>${esc(formatCount(counts.families))}</strong>
        <small>${esc(tx("summary_families"))}</small>
      </div>
      <div class="harness-summary-card">
        <span class="harness-summary-label">${esc(tx("label_automations"))}</span>
        <strong>${esc(formatCount(counts.automations))}</strong>
        <small>${esc(tx("summary_automations"))}</small>
      </div>
      <div class="harness-summary-card">
        <span class="harness-summary-label">${esc(tx("label_pending"))}</span>
        <strong>${esc(formatCount(counts.pendingHarnessAutomations))}</strong>
        <small>${esc(tx("summary_pending"))}</small>
      </div>
      <div class="harness-summary-card">
        <span class="harness-summary-label">${esc(tx("label_failing"))}</span>
        <strong>${esc(formatCount(counts.failingHarnessAutomations))}</strong>
        <small>${esc(tx("summary_failing"))}</small>
      </div>
    </div>
  `;
}

export function renderPlaceholder(titleKey, copyKey, counts = {}) {
  return `
    ${renderSummaryCards(counts)}
    <div class="harness-placeholder">
      <div class="harness-placeholder-title">${esc(tx(titleKey))}</div>
      <div class="harness-placeholder-copy">${esc(tx(copyKey))}</div>
    </div>
  `;
}

export function renderViewTabs(activeView) {
  const tabs = [
    { id: VIEW_MODES.ATLAS, label: tx("view_atlas") },
    { id: VIEW_MODES.PLACEMENT, label: tx("view_placement") },
    { id: VIEW_MODES.RUNS, label: tx("view_runs") },
    { id: VIEW_MODES.DRIFT, label: tx("view_drift"), placeholder: true },
  ];
  return `
    <div class="harness-viewbar">
      ${tabs.map((tab) => `
        <button
          class="harness-viewtab ${activeView === tab.id ? "active" : ""} ${tab.placeholder ? "is-placeholder" : ""}"
          type="button"
          data-harness-view="${tab.id}"
        >${esc(tab.label)}</button>
      `).join("")}
    </div>
  `;
}
