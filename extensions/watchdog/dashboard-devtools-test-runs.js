(function registerDashboardDevtoolsTestRunsModule() {
  const modules = window.OpenClawDevtoolsModules = window.OpenClawDevtoolsModules || {};

  modules.createTestRunsView = function createTestRunsView(app) {
    function renderVerificationLaunchCard() {
      const draft = app.state.selectedDraft;
      if (!draft) {
        return `
          <div class="devtool-detail-card">
            <div class="devtool-detail-head">
              <span>VERIFICATION TARGET</span>
              <strong>NONE</strong>
            </div>
            <div class="devtool-detail-text">Open or select a change-set draft first, then come here to launch a bound verification run.</div>
          </div>
        `;
      }

      const verification = app.getDraftVerificationRunConfig(draft);
      const canStart = Boolean(
        verification?.draftId
        && verification?.presetId
        && verification?.supported !== false
        && verification?.enabled !== false
        && !app.state.activeRunId,
      );
      const statusLabel = !verification?.supported
        ? "UNSUPPORTED"
        : verification?.enabled === false
          ? "DISABLED"
          : verification?.presetId
            ? "READY"
            : "UNCONFIGURED";

      return `
        <div class="devtool-detail-card">
          <div class="devtool-detail-head">
            <span>VERIFICATION TARGET</span>
            <strong>${app.esc(statusLabel)}</strong>
          </div>
          <div class="devtool-detail-line"><span>DRAFT</span><strong>${app.esc(verification?.title || draft.id || "--")}</strong></div>
          <div class="devtool-detail-line"><span>SURFACE</span><strong>${app.esc(verification?.surfaceId || "--")}</strong></div>
          <div class="devtool-detail-line"><span>PRESET</span><strong>${app.esc(verification?.presetId || "--")}</strong></div>
          <div class="devtool-detail-line"><span>CLEAN MODE</span><strong>${app.esc(verification?.cleanMode || "--")}</strong></div>
          <div class="devtool-detail-line"><span>EXECUTION</span><strong>${app.esc(verification?.executionId || verification?.executionStatus || "--")}</strong></div>
          <div class="devtool-detail-text">${app.esc(
            canStart
              ? "Launching from here will bind the run back to the current draft, so the verification chain stays connected."
              : "This draft is not currently ready for a bound verification run. You can still use standalone presets below.",
          )}</div>
          <div class="devtool-inline-actions">
            <button class="devtool-btn compact" data-open-current-draft="${app.esc(draft.id)}">
              <span class="devtool-btn-title">OPEN CURRENT DRAFT</span>
              <span class="devtool-btn-desc">${app.esc(draft.id)}</span>
            </button>
            <button class="devtool-btn compact ${app.state.startingPresetId === (verification?.presetId || "") ? "busy" : ""}" data-start-draft-verification="1" ${canStart ? "" : "disabled"}>
              <span class="devtool-btn-title">${app.esc(app.state.startingPresetId === (verification?.presetId || "") ? "STARTING..." : "START RECOMMENDED VERIFY")}</span>
              <span class="devtool-btn-desc">${app.esc(canStart ? `${verification.presetId} // bound to ${draft.id}` : "verification run unavailable for current draft")}</span>
            </button>
          </div>
        </div>
      `;
    }

    function renderOperatorRunContext(run) {
      if (!run) return "";
      const originDraft = app.getOperatorDraftSummaryById(run.originDraftId);
      const canOpenOriginDraft = Boolean(run.originDraftId);
      const canAttachOriginDraft = Boolean(
        originDraft
        && run.id
        && ["completed", "failed"].includes(String(run.status || "").toLowerCase()),
      );
      const contextLabel = canOpenOriginDraft ? "DRAFT-BOUND" : "STANDALONE";

      return `
        <div class="devtool-detail-card">
          <div class="devtool-detail-head">
            <span>OPERATOR CONTEXT</span>
            <strong>${app.esc(contextLabel)}</strong>
          </div>
          <div class="devtool-detail-line"><span>ORIGIN DRAFT</span><strong>${app.esc(run.originDraftId || "--")}</strong></div>
          <div class="devtool-detail-line"><span>ORIGIN EXEC</span><strong>${app.esc(run.originExecutionId || "--")}</strong></div>
          <div class="devtool-detail-line"><span>ORIGIN SURFACE</span><strong>${app.esc(run.originSurfaceId || originDraft?.surfaceId || "--")}</strong></div>
          <div class="devtool-detail-line"><span>DRAFT STATUS</span><strong>${app.esc(originDraft?.lastVerificationStatus || originDraft?.status || "--")}</strong></div>
          <div class="devtool-detail-line"><span>TITLE</span><strong>${app.esc(originDraft?.title || "--")}</strong></div>
          <div class="devtool-detail-text">${app.esc(
            canOpenOriginDraft
              ? "This run came from an operator draft. You can jump back to the draft or bind this run as verification evidence directly from here."
              : "This run was started directly from TEST RUNS and is not currently bound to a change-set draft.",
          )}</div>
          ${canOpenOriginDraft
            ? `<div class="devtool-inline-actions">
                <button class="devtool-btn compact" data-open-origin-draft="${app.esc(run.originDraftId)}">
                  <span class="devtool-btn-title">OPEN ORIGIN DRAFT</span>
                  <span class="devtool-btn-desc">${app.esc(run.originDraftId)}</span>
                </button>
                <button class="devtool-btn compact ${app.state.linkingVerification ? "busy" : ""}" data-link-origin-draft="${app.esc(run.originDraftId)}" ${canAttachOriginDraft ? "" : "disabled"}>
                  <span class="devtool-btn-title">${app.esc(app.state.linkingVerification ? "LINKING..." : "LINK TO DRAFT")}</span>
                  <span class="devtool-btn-desc">${app.esc(canAttachOriginDraft ? "Attach this run as verification evidence." : "Complete the run first to link it back.")}</span>
                </button>
              </div>`
            : ""}
        </div>
      `;
    }

    function renderRuntimeSnapshot(contractRuntime) {
      if (!contractRuntime) return "";
      const cards = [
        app.renderDetailCard("PROTOCOL", contractRuntime.protocol),
        app.renderDetailCard("FOLLOW UP", contractRuntime.followUp),
        app.renderDetailCard("SYSTEM ACTION DELIVERY", contractRuntime.systemActionDelivery),
        app.renderDetailCard("DELIVERY TICKET", contractRuntime.systemActionDeliveryTicket),
        app.renderDetailCard("SEMANTIC OUTCOME", contractRuntime.semanticOutcome),
        app.renderDetailCard("SYSTEM ACTION", contractRuntime.systemAction),
        app.renderDetailCard("RUNTIME DIAGNOSTICS", contractRuntime.runtimeDiagnostics),
      ].filter(Boolean).join("");
      if (!cards) return "";

      return `
        <div class="devtool-section-title">RUNTIME SNAPSHOT</div>
        <div class="devtool-runtime-grid">${cards}</div>
      `;
    }

    function renderCaseDetail(run) {
      const cases = Array.isArray(run?.caseResults) ? run.caseResults : [];
      const selected = cases.find((item) => item.id === app.state.selectedCaseId) || cases[0] || null;
      if (!selected) {
        return '<div class="devtool-empty compact">NO CASE DETAIL</div>';
      }

      const diagnosis = selected.diagnosis
        ? `
          <div class="devtool-detail-card diagnosis ${app.esc(String(selected.diagnosis.status || "").toLowerCase())}">
            <div class="devtool-detail-head">
              <span>DIAGNOSIS</span>
              <strong>${app.esc(selected.diagnosis.status || "--")}</strong>
            </div>
            <div class="devtool-detail-line"><span>CODE</span><strong>${app.esc(selected.diagnosis.errorCode || "--")}</strong></div>
            <div class="devtool-detail-line"><span>SUBSYSTEM</span><strong>${app.esc(selected.diagnosis.subsystem || "--")}</strong></div>
            <div class="devtool-detail-text">${app.esc(selected.diagnosis.conclusion || "")}</div>
            <div class="devtool-detail-evidence">${app.esc(selected.diagnosis.evidence || "")}</div>
            ${selected.diagnosis.runtimeHint ? `<div class="devtool-detail-line"><span>RUNTIME</span><strong>${app.esc(selected.diagnosis.runtimeHint.lane || "--")}</strong></div>` : ""}
            ${selected.diagnosis.runtimeHint?.summary ? `<div class="devtool-detail-text">${app.esc(selected.diagnosis.runtimeHint.summary)}</div>` : ""}
            ${selected.diagnosis.runtimeHint?.detail ? `<div class="devtool-detail-evidence">${app.esc(selected.diagnosis.runtimeHint.detail)}</div>` : ""}
          </div>
        `
        : '<div class="devtool-detail-card"><div class="devtool-detail-head"><span>DIAGNOSIS</span><strong>PASS</strong></div><div class="devtool-detail-text">No failure diagnosis recorded for this case.</div></div>';

      const checkpointRows = (selected.checkpoints || []).map((item) => {
        const statusClass = String(item.status || "").toLowerCase();
        return `<div class="devtool-checkpoint-row status-${app.esc(statusClass)}">
          <div class="devtool-checkpoint-head">
            <span class="devtool-checkpoint-id">${app.esc(item.id)}</span>
            <span class="devtool-checkpoint-name">${app.esc(item.name || "--")}</span>
            <span class="devtool-checkpoint-status">${app.esc(item.status || "--")}</span>
          </div>
          <div class="devtool-checkpoint-meta">${app.esc(item.elapsed || "--")}${item.errorCode ? ` // ${app.esc(item.errorCode)}` : ""}</div>
          ${item.detail ? `<div class="devtool-checkpoint-detail">${app.esc(item.detail)}</div>` : ""}
        </div>`;
      }).join("");

      const caseStatus = selected.pass ? "PASS" : selected.blocked ? "BLOCKED" : "FAIL";
      const runtimeSnapshot = renderRuntimeSnapshot(selected.contractRuntime);

      return `
        <div class="devtool-detail-shell">
          <div class="devtool-detail-summary">
            <div class="devtool-detail-line"><span>CASE</span><strong>${app.esc(selected.id)}</strong></div>
            <div class="devtool-detail-line"><span>STATUS</span><strong>${caseStatus}</strong></div>
            <div class="devtool-detail-line"><span>CONTRACT</span><strong>${app.esc(selected.contractId || "--")}</strong></div>
            <div class="devtool-detail-line"><span>DURATION</span><strong>${app.esc(selected.duration || "--")}</strong></div>
            <div class="devtool-detail-line"><span>CONTRACT STATUS</span><strong>${app.esc(selected.contractRuntime?.status || "--")}</strong></div>
            <div class="devtool-detail-line"><span>TASK TYPE</span><strong>${app.esc(selected.contractRuntime?.taskType || "--")}</strong></div>
            ${selected.finalStats ? `<div class="devtool-detail-text">${app.esc(selected.finalStats)}</div>` : ""}
          </div>
          ${diagnosis}
          ${runtimeSnapshot}
          <div class="devtool-section-title">CHECKPOINT FLOW</div>
          <div class="devtool-checkpoint-list">${checkpointRows || '<div class="devtool-empty compact">NO CHECKPOINTS</div>'}</div>
        </div>
      `;
    }

    function renderActions() {
      const host = document.getElementById("testDevtoolActions");
      if (!host) return;

      const disabled = !!app.state.activeRunId;
      const presetButtons = app.state.presets.map((preset) => {
        const busy = app.state.startingPresetId === preset.id;
        return `<button class="devtool-btn ${busy ? "busy" : ""}" data-preset-id="${app.esc(preset.id)}" ${disabled || busy ? "disabled" : ""}>
          <span class="devtool-btn-title">${app.esc(preset.label)}</span>
          <span class="devtool-btn-desc">${app.esc(preset.description)}</span>
        </button>`;
      }).join("");

      host.innerHTML = `
        ${renderVerificationLaunchCard()}
        <div class="devtool-detail-card">
          <div class="devtool-detail-head">
            <span>STANDALONE PRESETS</span>
            <strong>${app.esc(app.state.presets.length)}</strong>
          </div>
          <div class="devtool-detail-text">These presets run without automatically binding to the currently selected draft.</div>
        </div>
        ${presetButtons}
      `;

      host.querySelectorAll("[data-preset-id]").forEach((button) => {
        button.addEventListener("click", () => app.startPreset(button.getAttribute("data-preset-id")));
      });
      host.querySelectorAll("[data-open-current-draft]").forEach((button) => {
        button.addEventListener("click", () => app.openDraftInChangeSets(button.getAttribute("data-open-current-draft")));
      });
      host.querySelectorAll("[data-start-draft-verification]").forEach((button) => {
        button.addEventListener("click", () => {
          const verification = app.getDraftVerificationRunConfig(app.state.selectedDraft);
          if (!verification?.presetId || !verification?.draftId) return;
          void app.startPreset(verification.presetId, {
            cleanMode: verification.cleanMode,
            originDraftId: verification.draftId,
            originExecutionId: verification.executionId,
            originSurfaceId: verification.surfaceId,
          });
        });
      });
    }

    function renderSummary(errorMessage) {
      const host = document.getElementById("testDevtoolSummary");
      if (!host) return;
      if (errorMessage) {
        host.innerHTML = `<div class="devtool-empty">LOAD ERROR<br>${app.esc(errorMessage)}</div>`;
        return;
      }

      const run = app.state.selectedRun;
      if (!run) {
        host.innerHTML = '<div class="devtool-empty">NO TEST RUN YET<br>SELECT A DRAFT TO VERIFY OR START A PRESET.</div>';
        return;
      }

      const caseRows = (run.caseResults || []).map((item) => {
        const status = item.pass ? "PASS" : item.blocked ? "BLOCKED" : "FAIL";
        return `<button class="devtool-case-row status-${status.toLowerCase()} ${app.state.selectedCaseId === item.id ? "selected" : ""}" data-case-id="${app.esc(item.id)}">
          <div class="devtool-case-head">
            <span class="devtool-case-id">${app.esc(item.id)}</span>
            <span class="devtool-case-status">${status}</span>
          </div>
          <div class="devtool-case-meta">${app.esc(item.message || "")}</div>
          <div class="devtool-case-meta">${app.esc(item.contractId || "--")} // ${app.esc(item.duration || "--")}</div>
        </button>`;
      }).join("");

      const detailBlock = renderCaseDetail(run);
      const reportBlock = run.reportText
        ? `<pre class="devtool-report">${app.esc(run.reportText)}</pre>`
        : '<div class="devtool-empty compact">REPORT WILL APPEAR AFTER RUN COMPLETES.</div>';

      host.innerHTML = `
        <div class="devtool-summary-head">
          <div>
            <div class="devtool-run-label">${app.esc(run.label)}</div>
            <div class="devtool-run-id">${app.esc(run.id)}</div>
          </div>
          <div class="devtool-run-status status-${app.esc(run.status)}">${app.esc(run.status)}</div>
        </div>
        <div class="devtool-kv-grid">
          <div><span>START</span><strong>${app.esc(app.formatTimestamp(run.startedAt))}</strong></div>
          <div><span>END</span><strong>${app.esc(app.formatTimestamp(run.finishedAt))}</strong></div>
          <div><span>DURATION</span><strong>${app.esc(app.formatDuration(run.durationMs))}</strong></div>
          <div><span>MODE</span><strong>${app.esc(run.transport)} / ${app.esc(run.cleanMode)}</strong></div>
          <div><span>PASS</span><strong>${run.passedCases}</strong></div>
          <div><span>FAIL</span><strong>${run.failedCases}</strong></div>
        </div>
        ${renderOperatorRunContext(run)}
        <div class="devtool-section-title">CASE RESULTS</div>
        <div class="devtool-case-list">${caseRows || '<div class="devtool-empty compact">RUNNING...</div>'}</div>
        <div class="devtool-section-title">FLOW DETAIL</div>
        ${detailBlock}
        <div class="devtool-section-title">REPORT</div>
        ${reportBlock}
      `;

      host.querySelectorAll("[data-case-id]").forEach((button) => {
        button.addEventListener("click", () => app.selectCase(button.getAttribute("data-case-id")));
      });
      host.querySelectorAll("[data-open-origin-draft]").forEach((button) => {
        button.addEventListener("click", () => app.openDraftInChangeSets(button.getAttribute("data-open-origin-draft")));
      });
      host.querySelectorAll("[data-link-origin-draft]").forEach((button) => {
        button.addEventListener("click", () => {
          const draftId = button.getAttribute("data-link-origin-draft");
          if (!draftId || !run?.id) return;
          void app.attachRunToDraft({
            draftId,
            runId: run.id,
            note: "linked from TEST RUNS origin",
          }).then(() => {
            app.openDraftInChangeSets(draftId);
          });
        });
      });
    }

    function renderHistory() {
      const host = document.getElementById("testDevtoolHistory");
      if (!host) return;
      if (!app.state.runs.length) {
        host.innerHTML = '<div class="devtool-empty">RUN HISTORY EMPTY</div>';
        return;
      }

      const selectedDraftId = app.state.selectedDraft?.id || app.state.selectedDraftId || null;
      const runs = [...app.state.runs].sort((left, right) => {
        const leftRelated = selectedDraftId && left.originDraftId === selectedDraftId;
        const rightRelated = selectedDraftId && right.originDraftId === selectedDraftId;
        if (leftRelated !== rightRelated) return leftRelated ? -1 : 1;
        const leftActive = left.id === app.state.activeRunId;
        const rightActive = right.id === app.state.activeRunId;
        if (leftActive !== rightActive) return leftActive ? -1 : 1;
        return (Number(right.startedAt) || Number(right.finishedAt) || 0)
          - (Number(left.startedAt) || Number(left.finishedAt) || 0);
      });

      host.innerHTML = runs.map((run) => `
        <button class="devtool-history-item ${app.state.selectedRunId === run.id ? "selected" : ""}" data-run-id="${app.esc(run.id)}">
          <div class="devtool-history-head">
            <span>${app.esc(run.label)}</span>
            <span class="status-${app.esc(run.status)}">${app.esc(run.status)}</span>
          </div>
          <div class="devtool-history-meta">${app.esc(run.id)}</div>
          <div class="devtool-history-meta">${app.esc(run.originDraftId || "standalone")} // ${run.completedCases}/${run.totalCases}</div>
          <div class="devtool-history-meta">${app.esc(app.formatDuration(run.durationMs))} // ${app.esc(run.originDraftId === selectedDraftId ? "RELATED" : "GLOBAL")}</div>
        </button>
      `).join("");

      host.querySelectorAll("[data-run-id]").forEach((button) => {
        button.addEventListener("click", () => app.selectRun(button.getAttribute("data-run-id")));
      });
    }

    return {
      renderActions,
      renderSummary,
      renderHistory,
    };
  };
})();
