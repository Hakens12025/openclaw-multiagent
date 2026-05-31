// dashboard-control-plane.js — ⑤ Operator self-evolution control plane (standalone page).
// LEFT: operator review (run reports / EvaluationResult). MIDDLE: structure snapshot code +
// share code (capture/rollback/export). RIGHT: tiered change proposals.
// Reuses control-plane HTTP routes + /watchdog/operator-snapshot + /watchdog/admin-change-sets.
import { esc, getToken } from "./dashboard-common.js";
import { initDashboardSubpage } from "./dashboard-subpage-init.js";

const REFRESH_INTERVAL_MS = 30000;
const state = { snapshots: [], proposals: [], review: null, shareCode: null, error: "" };

function apiUrl(path) {
  const token = getToken();
  const sep = path.includes("?") ? "&" : "?";
  return token ? `${path}${sep}token=${encodeURIComponent(token)}` : path;
}
async function get(path) {
  try {
    const r = await fetch(apiUrl(path));
    return await r.json();
  } catch { return null; }
}
async function post(path, body) {
  const r = await fetch(apiUrl(path), {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}),
  });
  return r.json().catch(() => ({}));
}

function tierOf(risk, confirmation) {
  if (risk === "destructive") return { n: 4, key: "DESTRUCTIVE" };
  if (risk === "structural") return { n: 3, key: "STRUCTURAL" };
  if (confirmation === "explicit") return { n: 2, key: "GUARDED" };
  return { n: 1, key: "SAFE" };
}
function fmtTs(ts) {
  if (!Number.isFinite(ts)) return "--";
  try { return new Date(ts).toLocaleString(); } catch { return String(ts); }
}

async function refresh() {
  const [snap, drafts, review] = await Promise.all([
    get("/watchdog/control-plane/snapshot"),
    get("/watchdog/admin-change-sets"),
    get("/watchdog/operator-snapshot"),
  ]);
  state.snapshots = Array.isArray(snap?.snapshots) ? snap.snapshots : [];
  state.proposals = Array.isArray(drafts?.drafts) ? drafts.drafts : [];
  state.review = review || null;
  render();
}

function renderReview() {
  const host = document.getElementById("cpReview");
  if (!host) return;
  const r = state.review || {};
  const attention = Array.isArray(r.attention) ? r.attention : (Array.isArray(r.workItems) ? r.workItems : []);
  const loops = r.loops || {};
  host.innerHTML = `
    <div class="cp-section-head">OPERATOR 审查</div>
    <div class="cp-card">
      <div class="cp-line"><span>ACTIVE LOOP</span><strong>${esc(loops.activeSession?.loopId || "--")}</strong></div>
      <div class="cp-line"><span>REGISTERED LOOPS</span><strong>${esc(String((loops.registered || []).length))}</strong></div>
      <div class="cp-line"><span>ATTENTION</span><strong>${esc(String(attention.length))}</strong></div>
      <div class="cp-text">operator 消费的运行报告 / EvaluationResult / 关注项(只读)。</div>
    </div>
    ${attention.slice(0, 10).map((a) => `
      <div class="cp-card">
        <div class="cp-line"><span>${esc(a.agentId || a.kind || "item")}</span><strong>${esc(a.status || a.state || "--")}</strong></div>
        <div class="cp-text">${esc((a.task || a.summary || a.reason || "").slice(0, 160))}</div>
      </div>`).join("") || `<div class="cp-empty">无关注项</div>`}
  `;
}

function renderStructure() {
  const host = document.getElementById("cpStructure");
  if (!host) return;
  const latest = state.snapshots[0];
  host.innerHTML = `
    <div class="cp-section-head">结构快照码 / 分享码</div>
    <div class="cp-card cp-snapshot-bar">
      <div class="cp-line"><span>当前快照码</span><strong>${esc(latest?.id || "—")}</strong></div>
      <div class="cp-text">回滚地基。destructive/structural 改动 apply 前自动拍。</div>
      <button class="cp-btn" data-cp-capture="1">拍结构快照</button>
    </div>
    <div class="cp-card">
      <div class="cp-line"><span>结构分享码(可复现)</span></div>
      <div class="cp-text">L1 结构 / L2 +内容 / L3 +api(含密钥勿外传)。brotli 压缩,几 KB。</div>
      <div class="cp-btn-row">
        <button class="cp-btn" data-cp-share="S">L1 结构</button>
        <button class="cp-btn" data-cp-share="SC">L2 +内容</button>
        <button class="cp-btn" data-cp-share="SCA">L3 +api</button>
      </div>
      ${state.shareCode ? `
        <div class="cp-line"><span>${esc(state.shareCode.level || "?")} · ${esc(String(state.shareCode.sizeBytes || 0))}B${state.shareCode.containsSecrets ? " · 含密钥勿传" : ""}</span></div>
        <textarea class="cp-code-box" readonly>${esc(state.shareCode.code || state.shareCode.error || "")}</textarea>` : ""}
    </div>
    <div class="cp-card">
      <div class="cp-line"><span>快照历史 / 回滚</span><strong>${esc(String(state.snapshots.length))}</strong></div>
      ${state.snapshots.slice(0, 15).map((s) => `
        <div class="cp-line cp-snap-row">
          <span>${esc(s.id)}<em>${esc(fmtTs(s.capturedAt))}</em></span>
          <button class="cp-btn danger compact" data-cp-rollback="${esc(s.id)}" data-cp-hash="${esc(s.contentHash || "")}">回滚</button>
        </div>`).join("") || `<div class="cp-empty">无快照</div>`}
    </div>
  `;
}

// client-side "what the system becomes" — mirrors lib/control-plane/proposal-tier.js describeProposalEffect.
function describeEffect(surfaceId, payload = {}) {
  const p = payload || {};
  switch (surfaceId) {
    case "graph.edge.add": return `新增授权边 ${p.from} → ${p.to}`;
    case "graph.edge.delete": return `删除授权边 ${p.from} → ${p.to}`;
    case "graph.loop.compose": return `把 ${(p.agents || []).join("→") || "成员"} 连成 loop`;
    case "graph.loop.delete": return `注销 loop ${p.loopId || ""}`;
    case "agents.create": return `新建 agent ${p.id || ""}(role=${p.role || "?"})`;
    case "agents.delete": case "agents.hard_delete": return `删除 agent ${p.agentId || p.id || ""}(不可逆,先拍快照)`;
    case "agents.model": return `把 ${p.agentId || ""} 模型改为 ${p.model || ""}`;
    case "skills.create": return `新建 skill ${p.skillId || p.id || ""}`;
    case "automations.governance": return `治理控制(熔断/复活 profile)`;
    default: return surfaceId ? `执行 ${surfaceId}` : "(未知)";
  }
}

function renderProposals() {
  const host = document.getElementById("cpProposals");
  if (!host) return;
  const rows = state.proposals
    .map((p) => ({ p, tier: tierOf(p.riskLevel, p.confirmation) }))
    .sort((a, b) => b.tier.n - a.tier.n);
  const intro = `<div class="cp-section-head">提案</div>
    <div class="cp-card cp-intro">
      <div class="cp-text"><strong>提案 = operator 分析系统后提议的改动</strong>(改 graph/agent/loop/skill 等),按危险分级 T1-4,可 diff/apply/一键回滚。这是"自进化"闭环:operator 当大脑提改进,你审批。</div>
    </div>`;
  if (rows.length === 0) {
    host.innerHTML = intro + `<div class="cp-empty">
      暂无提案。<br><br>operator <strong>自动生成提案</strong>(每轮分析→提优化项)是 <strong>⑤ Phase4,尚未接线</strong>。<br>
      接线后这里会按危险分级列出 operator 提议的改动 + "改完变成什么样" + diff + 一键 apply/回滚。<br>
      当前也会显示任何已存在的 change-set 草稿。
    </div>`;
    return;
  }
  host.innerHTML = intro + rows.map(({ p, tier }) => `
    <div class="cp-card cp-tier cp-tier-${tier.n}">
      <div class="cp-line"><span>${esc(p.surfaceId || p.id)}</span><strong>T${tier.n} ${esc(tier.key)}</strong></div>
      <div class="cp-text"><strong>改完:</strong>${esc(describeEffect(p.surfaceId, p.changeSet?.payload || p.payload))}</div>
      <div class="cp-text">${esc(p.summary || p.title || "")}</div>
      <div class="cp-line"><span>STATUS</span><strong>${esc(p.status || "draft")}</strong></div>
    </div>`).join("");
}

function render() {
  renderReview();
  renderStructure();
  renderProposals();
  bind();
}

function bind() {
  document.querySelector("[data-cp-capture]")?.addEventListener("click", async () => {
    await post("/watchdog/control-plane/snapshot", { reason: "manual:control-plane-page" });
    refresh();
  });
  document.querySelectorAll("[data-cp-share]").forEach((b) => b.addEventListener("click", async () => {
    state.shareCode = await post("/watchdog/control-plane/share/export", { level: b.getAttribute("data-cp-share") });
    renderStructure();
    bind();
  }));
  document.querySelectorAll("[data-cp-rollback]").forEach((b) => b.addEventListener("click", async () => {
    const snapshotId = b.getAttribute("data-cp-rollback");
    if (!window.confirm(`回滚结构到 ${snapshotId}？会重写 graph/bindings/skills/automation。`)) return;
    const r = await post("/watchdog/control-plane/rollback", { snapshotId, expectHash: b.getAttribute("data-cp-hash") || null });
    window.alert(r.ok ? `已回滚到 ${snapshotId}` : `回滚失败: ${r.error || JSON.stringify(r.drift || r)}`);
    refresh();
  }));
}

function boot() {
  initDashboardSubpage({});
  render();
  refresh();
  window.setInterval(refresh, REFRESH_INTERVAL_MS);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
