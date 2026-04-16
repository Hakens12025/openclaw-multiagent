(function registerDashboardDevtoolsManagementModule() {
  const modules = window.OpenClawDevtoolsModules = window.OpenClawDevtoolsModules || {};

  modules.createManagementView = function createManagementView(app) {
    function renderCurrentDraftContextCard(subject, selectedTarget) {
      const draft = app.state.selectedDraft;
      const draftContext = app.getSelectedDraftManagementContext();
      if (!draft || !draftContext) {
        return `
          <div class="devtool-detail-card">
            <div class="devtool-detail-head">
              <span>CURRENT DRAFT CONTEXT</span>
              <strong>NONE</strong>
            </div>
            <div class="devtool-detail-text">No active change-set draft is currently selected.</div>
          </div>
        `;
      }

      const matchesSubject = draftContext.subjectKind === subject?.kind;
      const matchesTarget = draftContext.targetId && draftContext.targetId === selectedTarget?.id;
      const aligned = matchesSubject && matchesTarget;

      return `
        <div class="devtool-detail-card">
          <div class="devtool-detail-head">
            <span>CURRENT DRAFT CONTEXT</span>
            <strong>${app.esc(aligned ? "ALIGNED" : "OFFSET")}</strong>
          </div>
          <div class="devtool-detail-line"><span>DRAFT</span><strong>${app.esc(draft.title || draft.surfaceId || draft.id || "--")}</strong></div>
          <div class="devtool-detail-line"><span>SUBJECT</span><strong>${app.esc(draftContext.subjectLabel || draftContext.subjectKind || "--")}</strong></div>
          <div class="devtool-detail-line"><span>TARGET</span><strong>${app.esc(draftContext.targetLabel || draftContext.targetId || "--")}</strong></div>
          <div class="devtool-detail-line"><span>VIEW TARGET</span><strong>${app.esc(selectedTarget?.label || selectedTarget?.id || "--")}</strong></div>
          <div class="devtool-detail-text">${app.esc(
            aligned
              ? "Management view is already focused on the current draft target."
              : "Management view is not focused on the current draft target. You can jump back to the draft target or open the draft directly.",
          )}</div>
          <div class="devtool-inline-actions">
            <button class="devtool-btn compact" data-management-open-current-draft="${app.esc(draft.id)}">
              <span class="devtool-btn-title">OPEN CURRENT DRAFT</span>
              <span class="devtool-btn-desc">${app.esc(draft.id)}</span>
            </button>
            <button class="devtool-btn compact" data-management-focus-draft-target="1" ${aligned ? "disabled" : ""}>
              <span class="devtool-btn-title">FOCUS DRAFT TARGET</span>
              <span class="devtool-btn-desc">${app.esc(draftContext.targetLabel || draftContext.targetId || "--")}</span>
            </button>
          </div>
        </div>
      `;
    }

    function getManagementActivityPrimaryStatus(activity) {
      return activity?.lastVerification?.status
        || activity?.lastExecution?.status
        || activity?.lastDraft?.status
        || null;
    }

    function buildManagementActivityMeta(activity) {
      if (!activity) return "NO PLATFORM HISTORY";
      return [
        `draft ${activity.draftCount || 0}`,
        `exec ${activity.executionCount || 0}`,
        `verify ${activity.verificationCount || 0}`,
        `last ${getManagementActivityPrimaryStatus(activity) || "--"}`,
      ].join(" // ");
    }

    function renderManagementTargetActivityCard(activity) {
      if (!activity) {
        return `
          <div class="devtool-detail-card">
            <div class="devtool-detail-head">
              <span>TARGET ACTIVITY</span>
              <strong>IDLE</strong>
            </div>
            <div class="devtool-detail-text">No draft, execution, or verification history is currently attached to this target.</div>
          </div>
        `;
      }

      const canOpenLastDraft = Boolean(activity?.lastDraft?.id);
      const canOpenLastRun = Boolean(activity?.lastVerification?.runId);
      return `
        <div class="devtool-detail-card">
          <div class="devtool-detail-head">
            <span>TARGET ACTIVITY</span>
            <strong>${app.esc(getManagementActivityPrimaryStatus(activity) || "--")}</strong>
          </div>
          <div class="devtool-kv-grid compact">
            <div><span>DRAFTS</span><strong>${activity.draftCount || 0}</strong></div>
            <div><span>EXEC</span><strong>${activity.executionCount || 0}</strong></div>
            <div><span>VERIFY</span><strong>${activity.verificationCount || 0}</strong></div>
            <div><span>LAST CHANGE</span><strong>${app.esc(app.formatTimestamp(activity.lastActivityAt))}</strong></div>
          </div>
          <div class="devtool-detail-line"><span>LAST DRAFT</span><strong>${app.esc(activity.lastDraft?.title || activity.lastDraft?.id || "--")}</strong></div>
          <div class="devtool-detail-line"><span>DRAFT STATUS</span><strong>${app.esc(activity.lastDraft?.status || "--")}</strong></div>
          <div class="devtool-detail-line"><span>LAST EXEC</span><strong>${app.esc(activity.lastExecution?.status || "--")} // ${app.esc(app.formatTimestamp(activity.lastExecution?.at))}</strong></div>
          <div class="devtool-detail-line"><span>LAST VERIFY</span><strong>${app.esc(activity.lastVerification?.status || "--")} // ${app.esc(app.formatTimestamp(activity.lastVerification?.at))}</strong></div>
          ${canOpenLastDraft || canOpenLastRun
            ? `<div class="devtool-inline-actions">
                ${canOpenLastDraft
                  ? `<button class="devtool-btn compact" data-management-open-draft="${app.esc(activity.lastDraft.id)}">
                      <span class="devtool-btn-title">OPEN LAST DRAFT</span>
                      <span class="devtool-btn-desc">${app.esc(activity.lastDraft.id)}</span>
                    </button>`
                  : ""}
                ${canOpenLastRun
                  ? `<button class="devtool-btn compact" data-management-open-run="${app.esc(activity.lastVerification.runId)}">
                      <span class="devtool-btn-title">OPEN LAST RUN</span>
                      <span class="devtool-btn-desc">${app.esc(activity.lastVerification.runId)}</span>
                    </button>`
                  : ""}
              </div>`
            : ""}
        </div>
      `;
    }

    function renderManagementTargetPolicyCard(target) {
      if (!target?.composeAgentId) return "";
      const policies = app.normalizeRecord(target?.policies || target?.snapshot?.policies || target?.snapshot?.binding?.policies);
      const policySurfaceEnabled = Array.isArray(target?.applySurfaceIds) && target.applySurfaceIds.includes("agents.policy");
      const ingressLabel = policies.gateway === true
        ? (policies.ingressSource || "default")
        : "not-gateway";

      return `
        <div class="devtool-detail-card">
          <div class="devtool-detail-head">
            <span>INSTANCE POLICY</span>
            <strong>${app.esc(target?.policySummary || "office")}</strong>
          </div>
          <div class="devtool-kv-grid compact">
            <div><span>GATEWAY</span><strong>${policies.gateway === true ? "YES" : "NO"}</strong></div>
            <div><span>INGRESS</span><strong>${app.esc(ingressLabel)}</strong></div>
            <div><span>PROTECTED</span><strong>${policies.protected === true ? "YES" : "NO"}</strong></div>
            <div><span>SPECIALIZED</span><strong>${policies.specialized === true ? "YES" : "NO"}</strong></div>
            <div><span>ROLE</span><strong>${app.esc(target?.snapshot?.role || "--")}</strong></div>
            <div><span>POLICY SURFACE</span><strong>${policySurfaceEnabled ? "agents.policy" : "--"}</strong></div>
          </div>
          <div class="devtool-detail-text">Instance policy is binding truth. Graph edges and loop membership are separate runtime collaboration truth.</div>
        </div>
      `;
    }

    function renderAutomationHarnessCard(target) {
      if (target?.selector?.key !== "automationId") return "";
      const snapshot = app.normalizeRecord(target?.snapshot);
      const summary = app.normalizeRecord(snapshot.summary);
      const runtime = app.normalizeRecord(snapshot.runtime);
      const activeRun = app.normalizeRecord(runtime.activeHarnessRun);
      const lastRun = app.normalizeRecord(runtime.lastHarnessRun);
      const activeGate = app.normalizeRecord(activeRun.gateSummary);
      const lastGate = app.normalizeRecord(lastRun.gateSummary);
      const coverage = app.normalizeRecord(summary.harnessCoverage);
      const coverageCounts = app.normalizeRecord(summary.harnessCoverageCounts);
      const activeModuleCounts = app.normalizeRecord(activeRun.moduleCounts);
      const lastModuleCounts = app.normalizeRecord(lastRun.moduleCounts);
      const activeVerdict = summary.activeHarnessGateVerdict || activeGate.verdict || "--";
      const lastVerdict = summary.lastHarnessGateVerdict || lastGate.verdict || "--";
      const activePending = Number(summary.activeHarnessPendingModuleCount) || Number(activeModuleCounts.pending) || 0;
      const activeFailed = Number(summary.activeHarnessFailedModuleCount) || Number(activeModuleCounts.failed) || 0;
      const lastFailed = Number(summary.lastHarnessFailedModuleCount) || Number(lastModuleCounts.failed) || 0;
      const parseHarnessId = (id) => {
        const raw = String(id || "");
        const colonIdx = raw.indexOf(":");
        if (colonIdx < 0) return raw;
        const rest = raw.slice(colonIdx + 1);
        const dotIdx = rest.indexOf(".");
        const name = dotIdx >= 0 ? rest.slice(dotIdx + 1) : rest;
        return name
          .replace(/[._]+/g, " ")
          .trim()
          .replace(/\b\w/g, (m) => m.toUpperCase()) || raw;
      };
      const formatList = (value) => {
        const items = Array.isArray(value)
          ? value.map((entry) => parseHarnessId(entry)).filter(Boolean)
          : [];
        return items.length ? items.join(", ") : "--";
      };

      return `
        <div class="devtool-detail-card">
          <div class="devtool-detail-head">
            <span>自动化塑形套件</span>
            <strong>${app.esc(summary.executionMode || "freeform")}</strong>
          </div>
          <div class="devtool-kv-grid compact">
            <div><span>STATUS</span><strong>${app.esc(summary.runtimeStatus || snapshot.runtime?.status || "--")}</strong></div>
            <div><span>ASSURANCE</span><strong>${app.esc(summary.assuranceLevel || "--")}</strong></div>
            <div><span>PROFILE</span><strong>${app.esc(summary.harnessProfileId || "--")}</strong></div>
            <div><span>TRUST</span><strong>${app.esc(summary.harnessProfileTrustLevel || "--")}</strong></div>
            <div><span>CURRENT ROUND</span><strong>${app.esc(summary.currentRound ?? "--")}</strong></div>
            <div><span>BEST SCORE</span><strong>${app.esc(summary.bestScore ?? "--")}</strong></div>
            <div><span>硬塑形</span><strong>${app.esc(coverageCounts.hardShaped ?? 0)}</strong></div>
            <div><span>软引导</span><strong>${app.esc(coverageCounts.softGuided ?? 0)}</strong></div>
            <div><span>自由发挥区</span><strong>${app.esc(coverageCounts.freeform ?? 0)}</strong></div>
            <div><span>ACTIVE GATE</span><strong>${app.esc(activeVerdict)}</strong></div>
            <div><span>PENDING</span><strong>${app.esc(activePending)}</strong></div>
            <div><span>FAILED</span><strong>${app.esc(Math.max(activeFailed, lastFailed))}</strong></div>
          </div>
          <div class="devtool-detail-line"><span>TARGET AGENT</span><strong>${app.esc(summary.targetAgent || "--")}</strong></div>
          <div class="devtool-detail-line"><span>ACTIVE RUN</span><strong>${app.esc(summary.activeHarnessRunId || activeRun.id || "--")} // R${app.esc(summary.activeHarnessRound ?? activeRun.round ?? "--")} // ${app.esc(summary.activeHarnessStatus || activeRun.status || "--")}</strong></div>
          <div class="devtool-detail-line"><span>LAST RUN</span><strong>${app.esc(lastRun.id || "--")} // ${app.esc(summary.lastHarnessStatus || lastRun.status || "--")} // ${app.esc(summary.lastHarnessDecision || lastRun.decision || "--")}</strong></div>
          <div class="devtool-detail-line"><span>LAST GATE</span><strong>${app.esc(lastVerdict)} // failed ${app.esc(lastFailed)}</strong></div>
          <div class="devtool-detail-line"><span>硬塑形</span><strong>${app.esc(formatList(coverage.hardShaped))}</strong></div>
          <div class="devtool-detail-line"><span>软引导</span><strong>${app.esc(formatList(coverage.softGuided))}</strong></div>
          <div class="devtool-detail-line"><span>自由发挥区</span><strong>${app.esc(formatList(coverage.freeform))}</strong></div>
          <div class="devtool-detail-line"><span>PENDING GATES</span><strong>${app.esc(formatList(activeGate.pendingModuleIds))}</strong></div>
          <div class="devtool-detail-line"><span>FAILED GATES</span><strong>${app.esc(formatList(activeGate.failedModuleIds?.length ? activeGate.failedModuleIds : lastGate.failedModuleIds))}</strong></div>
        </div>
      `;
    }

    function renderManagementSurfaceCard(surface, { selectedTarget = null } = {}) {
      const verificationCapability = app.normalizeRecord(surface?.verificationCapability);
      const verificationLabel = verificationCapability.supported
        ? `${verificationCapability.presetId || "preset"} // ${verificationCapability.cleanMode || "clean"}`
        : "unsupported";
      const canOpenInComposer = surface?.stage === "apply" && !!app.findAuthoringSurface(surface?.id);
      const creatingDraft = app.state.creatingManagementDraftSurfaceId === surface?.id;
      const readUrl = surface?.stage === "inspect" && surface?.method === "GET"
        ? app.buildManagementSurfaceReadUrl(surface)
        : null;

      return `
        <div class="devtool-detail-card">
          <div class="devtool-detail-head">
            <span>${app.esc(surface?.id || "--")}</span>
            <strong>${app.esc(surface?.aspect || surface?.stage || "--")}</strong>
          </div>
          <div class="devtool-detail-line"><span>STAGE</span><strong>${app.esc(surface?.stage || "--")}</strong></div>
          <div class="devtool-detail-line"><span>RISK</span><strong>${app.esc(surface?.risk || "--")}</strong></div>
          <div class="devtool-detail-line"><span>SCOPE</span><strong>${app.esc(surface?.subjectScope || "--")}</strong></div>
          <div class="devtool-detail-line"><span>CONFIRM</span><strong>${app.esc(surface?.confirmation || "--")}</strong></div>
          <div class="devtool-detail-line"><span>EXECUTABLE</span><strong>${app.esc(surface?.executable === true ? "yes" : "no")}</strong></div>
          <div class="devtool-detail-line"><span>OPERATOR</span><strong>${app.esc(surface?.operatorExecutable === true ? "plan+exec" : "no")}</strong></div>
          <div class="devtool-detail-line"><span>VERIFY</span><strong>${app.esc(verificationLabel)}</strong></div>
          ${selectedTarget && surface?.selectorKey
            ? `<div class="devtool-detail-line"><span>TARGET</span><strong>${app.esc(selectedTarget.label || selectedTarget.id || "--")}</strong></div>`
            : ""}
          ${surface?.summary ? `<div class="devtool-detail-text">${app.esc(surface.summary)}</div>` : ""}
          ${canOpenInComposer || readUrl ? `<div class="devtool-inline-actions">` : ""}
          ${canOpenInComposer
            ? `<button class="devtool-btn compact" data-management-compose-surface="${app.esc(surface.id)}">
                <span class="devtool-btn-title">OPEN IN CHANGE SETS</span>
                <span class="devtool-btn-desc">Use this surface in the typed draft composer.</span>
              </button>`
            : ""}
          ${canOpenInComposer
            ? `<button class="devtool-btn compact ${creatingDraft ? "busy" : ""}" data-management-create-draft-surface="${app.esc(surface.id)}" ${creatingDraft ? "disabled" : ""}>
                <span class="devtool-btn-title">${creatingDraft ? "CREATING..." : "CREATE DRAFT NOW"}</span>
                <span class="devtool-btn-desc">Create a typed draft immediately for the current target.</span>
              </button>`
            : ""}
          ${readUrl
            ? `<button class="devtool-btn compact" data-management-open-path="${app.esc(readUrl)}">
                <span class="devtool-btn-title">OPEN LIVE READ</span>
                <span class="devtool-btn-desc">Open the current read endpoint in a separate tab.</span>
              </button>`
            : ""}
          ${canOpenInComposer || readUrl ? "</div>" : ""}
        </div>
      `;
    }

    function renderActions() {
      const host = document.getElementById("testDevtoolActions");
      if (!host) return;

      const subjects = app.getManagementSubjects();
      const subjectButtons = subjects.map((subject) => `
        <button class="devtool-history-item ${app.state.selectedManagementKind === subject.kind ? "selected" : ""}" data-management-kind="${app.esc(subject.kind)}">
          <div class="devtool-history-head">
            <span>${app.esc(subject.label || subject.kind)}</span>
            <span>${subject.counts?.total || 0}</span>
          </div>
          <div class="devtool-history-meta">${app.esc(subject.kind)} // ${subject.counts?.apply || 0} APPLY // ${subject.counts?.operatorExecutable || 0} OPERATOR // ${subject.counts?.verificationSupported || 0} VERIFIABLE</div>
          <div class="devtool-history-meta">${app.esc(subject.summary || "--")}</div>
        </button>
      `).join("");

      const totalSubjects = subjects.length;
      const totalApply = subjects.reduce((sum, subject) => sum + (subject.counts?.apply || 0), 0);
      const totalOperator = subjects.reduce((sum, subject) => sum + (subject.counts?.operatorExecutable || 0), 0);
      const totalVerifiable = subjects.reduce((sum, subject) => sum + (subject.counts?.verificationSupported || 0), 0);
      const activeSubjectActivity = app.getManagementSubjectActivity(app.getSelectedManagementSubject());

      host.innerHTML = `
        <div class="devtool-detail-card">
          <div class="devtool-detail-head">
            <span>MANAGEMENT MAP</span>
            <strong>${app.esc(totalSubjects)}</strong>
          </div>
          <div class="devtool-kv-grid compact">
            <div><span>SUBJECTS</span><strong>${totalSubjects}</strong></div>
            <div><span>APPLY</span><strong>${totalApply}</strong></div>
            <div><span>OPERATOR</span><strong>${totalOperator}</strong></div>
            <div><span>VERIFIABLE</span><strong>${totalVerifiable}</strong></div>
            <div><span>ACTIVE</span><strong>${app.esc(app.getSelectedManagementSubject()?.label || "--")}</strong></div>
            <div><span>ACTIVE TARGETS</span><strong>${activeSubjectActivity?.targetCount || 0}</strong></div>
            <div><span>LAST CHANGE</span><strong>${app.esc(app.formatTimestamp(activeSubjectActivity?.lastActivityAt))}</strong></div>
          </div>
        </div>
        <div class="devtool-case-list">${subjectButtons || '<div class="devtool-empty compact">NO MANAGEMENT SUBJECTS</div>'}</div>
      `;

      host.querySelectorAll("[data-management-kind]").forEach((button) => {
        button.addEventListener("click", () => app.selectManagementSubject(button.getAttribute("data-management-kind")));
      });
    }

    function renderSummary(errorMessage) {
      const host = document.getElementById("testDevtoolSummary");
      if (!host) return;
      if (errorMessage) {
        host.innerHTML = `<div class="devtool-empty">LOAD ERROR<br>${app.esc(errorMessage)}</div>`;
        return;
      }

      const subject = app.getSelectedManagementSubject();
      if (!subject) {
        host.innerHTML = '<div class="devtool-empty">NO MANAGEMENT SUBJECTS<br>CAPABILITY REGISTRY NOT AVAILABLE.</div>';
        return;
      }

      const selectedTarget = app.getSelectedManagementTarget(subject);
      const inspectCards = Array.isArray(subject.inspectSurfaces)
        ? subject.inspectSurfaces.map((surface) => renderManagementSurfaceCard(surface, { selectedTarget })).join("")
        : "";
      const applyCards = Array.isArray(subject.applySurfaces)
        ? subject.applySurfaces.map((surface) => renderManagementSurfaceCard(surface, { selectedTarget })).join("")
        : "";
      const verifyCards = Array.isArray(subject.verifySurfaces)
        ? subject.verifySurfaces.map((surface) => renderManagementSurfaceCard(surface, { selectedTarget })).join("")
        : "";

      host.innerHTML = `
        <div class="devtool-summary-head">
          <div>
            <div class="devtool-run-label">${app.esc(subject.label || subject.kind)}</div>
            <div class="devtool-run-id">${app.esc(subject.kind)}</div>
          </div>
          <div class="devtool-run-status">${app.esc(subject.selectorKey ? `selector:${subject.selectorKey}` : "global")}</div>
        </div>
        <div class="devtool-kv-grid">
          <div><span>SCOPE</span><strong>${app.esc(Array.isArray(subject.scopes) ? subject.scopes.join(", ") : "--")}</strong></div>
          <div><span>SELECTOR</span><strong>${app.esc(subject.selectorKey || "--")}</strong></div>
          <div><span>TOTAL</span><strong>${subject.counts?.total || 0}</strong></div>
          <div><span>INSPECT</span><strong>${subject.counts?.inspect || 0}</strong></div>
          <div><span>APPLY</span><strong>${subject.counts?.apply || 0}</strong></div>
          <div><span>VERIFY</span><strong>${subject.counts?.verify || 0}</strong></div>
          <div><span>EXECUTABLE</span><strong>${subject.counts?.executable || 0}</strong></div>
          <div><span>OPERATOR</span><strong>${subject.counts?.operatorExecutable || 0}</strong></div>
          <div><span>VERIFIABLE</span><strong>${subject.counts?.verificationSupported || 0}</strong></div>
          <div><span>ASPECTS</span><strong>${Array.isArray(subject.managedAspects) ? subject.managedAspects.length : 0}</strong></div>
          <div><span>TARGET</span><strong>${app.esc(selectedTarget?.label || "--")}</strong></div>
          <div><span>ACTIVE TARGETS</span><strong>${subject.activity?.targetCount || 0}</strong></div>
          <div><span>LAST CHANGE</span><strong>${app.esc(app.formatTimestamp(subject.activity?.lastActivityAt))}</strong></div>
        </div>
        ${subject.summary ? `<div class="devtool-note">${app.esc(subject.summary)}</div>` : ""}
        ${renderCurrentDraftContextCard(subject, selectedTarget)}
        ${Array.isArray(subject.managedAspects) && subject.managedAspects.length
          ? app.renderDetailCard("MANAGED ASPECTS", subject.managedAspects, "MAP")
          : ""}
        <div class="devtool-section-title">INSPECT SURFACES</div>
        <div class="devtool-runtime-grid">${inspectCards || '<div class="devtool-empty compact">NO INSPECT SURFACES</div>'}</div>
        <div class="devtool-section-title">APPLY SURFACES</div>
        <div class="devtool-runtime-grid">${applyCards || '<div class="devtool-empty compact">NO APPLY SURFACES</div>'}</div>
        <div class="devtool-section-title">VERIFY SURFACES</div>
        <div class="devtool-runtime-grid">${verifyCards || '<div class="devtool-empty compact">NO VERIFY SURFACES</div>'}</div>
      `;

      host.querySelectorAll("[data-management-compose-surface]").forEach((button) => {
        button.addEventListener("click", () => app.openManagementSurfaceInComposer(button.getAttribute("data-management-compose-surface")));
      });
      host.querySelectorAll("[data-management-create-draft-surface]").forEach((button) => {
        button.addEventListener("click", () => { void app.createManagementDraft(button.getAttribute("data-management-create-draft-surface")); });
      });
      host.querySelectorAll("[data-management-open-path]").forEach((button) => {
        button.addEventListener("click", () => app.openManagementSurfaceRead(button.getAttribute("data-management-open-path")));
      });
      host.querySelectorAll("[data-management-open-current-draft]").forEach((button) => {
        button.addEventListener("click", () => app.openDraftInChangeSets(button.getAttribute("data-management-open-current-draft")));
      });
      host.querySelectorAll("[data-management-focus-draft-target]").forEach((button) => {
        button.addEventListener("click", () => app.focusManagementContext(app.getSelectedDraftManagementContext()));
      });
    }

    function renderHistory() {
      const host = document.getElementById("testDevtoolHistory");
      if (!host) return;

      const subject = app.getSelectedManagementSubject();
      if (!subject) {
        host.innerHTML = '<div class="devtool-empty">NO TARGET CONTEXT</div>';
        return;
      }

      const targets = app.buildManagementTargetEntries(subject);
      const selectedTarget = app.getSelectedManagementTarget(subject);
      const targetRows = targets.map((target) => {
        const activity = app.getManagementTargetActivity(subject, target);
        return `
        <button class="devtool-history-item ${selectedTarget?.id === target.id ? "selected" : ""}" data-management-target-id="${app.esc(target.id)}">
          <div class="devtool-history-head">
            <span>${app.esc(target.label || target.id)}</span>
            <span>${app.esc(target.id)}</span>
          </div>
          <div class="devtool-history-meta">${app.esc(target.meta || "--")}</div>
          <div class="devtool-history-meta">${app.esc(buildManagementActivityMeta(activity))}</div>
          <div class="devtool-history-meta">${app.esc(target.detail || "--")}</div>
        </button>
      `;
      }).join("");
      const selectedTargetActivity = app.getManagementTargetActivity(subject, selectedTarget);
      const selectedTargetDescription = selectedTarget?.description || selectedTarget?.detail || null;

      host.innerHTML = `
        ${selectedTargetDescription
          ? `<div class="devtool-detail-card">
              <div class="devtool-detail-head">
                <span>SELECTED TARGET</span>
                <strong>${app.esc(selectedTarget.id || "--")}</strong>
              </div>
              <div class="devtool-detail-text">${app.esc(selectedTargetDescription)}</div>
            </div>`
          : ""}
        ${renderManagementTargetPolicyCard(selectedTarget)}
        ${renderManagementTargetActivityCard(selectedTargetActivity)}
        ${renderAutomationHarnessCard(selectedTarget)}
        ${selectedTarget?.snapshot ? app.renderDetailCard("TARGET SNAPSHOT", selectedTarget.snapshot, "TARGET") : ""}
        <div class="devtool-section-title">AVAILABLE TARGETS</div>
        <div class="devtool-case-list">${targetRows || '<div class="devtool-empty compact">NO TARGETS FOR THIS SUBJECT</div>'}</div>
      `;

      host.querySelectorAll("[data-management-target-id]").forEach((button) => {
        button.addEventListener("click", () => app.selectManagementTarget(button.getAttribute("data-management-target-id")));
      });
      host.querySelectorAll("[data-management-open-draft]").forEach((button) => {
        button.addEventListener("click", () => app.openDraftInChangeSets(button.getAttribute("data-management-open-draft")));
      });
      host.querySelectorAll("[data-management-open-run]").forEach((button) => {
        button.addEventListener("click", () => app.openRunInTestRuns(button.getAttribute("data-management-open-run")));
      });
    }

    return {
      renderActions,
      renderSummary,
      renderHistory,
    };
  };
})();
