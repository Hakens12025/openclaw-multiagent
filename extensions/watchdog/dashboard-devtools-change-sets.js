(function registerDashboardDevtoolsChangeSetsModule() {
  const modules = window.OpenClawDevtoolsModules = window.OpenClawDevtoolsModules || {};

  modules.createChangeSetView = function createChangeSetView(app) {
    function renderVerificationRecord(record, selected) {
      const statusClass = app.normalizeStatusClass(record.verificationStatus || record.status);
      const failedCases = Array.isArray(record.failedCaseIds) ? record.failedCaseIds : [];
      const blockedCases = Array.isArray(record.blockedCaseIds) ? record.blockedCaseIds : [];
      const pathLabel = record.reportPath || record.rawReportFile || record.reportFile || "--";
      return `
        <button class="devtool-case-row status-${app.esc(statusClass)} ${selected ? "selected" : ""}" data-verification-id="${app.esc(record.id)}">
          <div class="devtool-case-head">
            <span class="devtool-case-id">${app.esc(record.runId || record.id)}</span>
            <span class="devtool-case-status">${app.esc(record.verificationStatus || record.status || "--")}</span>
          </div>
          <div class="devtool-case-meta">${app.esc(record.label || record.presetId || record.source || "--")}</div>
          <div class="devtool-case-meta">${record.passedCases}/${record.totalCases} PASS // ${record.failedCases} FAIL // ${record.blockedCases} BLOCKED</div>
          ${failedCases.length ? `<div class="devtool-checkpoint-detail">FAILED // ${app.esc(failedCases.join(", "))}</div>` : ""}
          ${blockedCases.length ? `<div class="devtool-checkpoint-detail">BLOCKED // ${app.esc(blockedCases.join(", "))}</div>` : ""}
          <div class="devtool-case-meta">${app.esc(pathLabel)}</div>
        </button>
      `;
    }

    function renderVerificationDetail(record, { latest = false } = {}) {
      if (!record) {
        return '<div class="devtool-empty compact">NO VERIFICATION DETAIL</div>';
      }

      const detailObject = {
        source: record.source || null,
        runId: record.runId || null,
        presetId: record.presetId || null,
        suite: record.suite || null,
        linkedAt: record.linkedAt || null,
        startedAt: record.startedAt || null,
        finishedAt: record.finishedAt || null,
        durationMs: record.durationMs || null,
        reportPath: record.reportPath || null,
        reportFile: record.reportFile || null,
        rawReportFile: record.rawReportFile || null,
        failedCaseIds: record.failedCaseIds || [],
        blockedCaseIds: record.blockedCaseIds || [],
        note: record.note || null,
      };

      return `
        <div class="devtool-detail-card">
          <div class="devtool-detail-head">
            <span>${app.esc(latest ? "LATEST EVIDENCE" : "SELECTED EVIDENCE")}</span>
            <strong>${app.esc(record.verificationStatus || record.status || "--")}</strong>
          </div>
          <div class="devtool-detail-line"><span>LINKED</span><strong>${app.esc(app.formatTimestamp(record.linkedAt))}</strong></div>
          <div class="devtool-detail-line"><span>RUN</span><strong>${app.esc(record.runId || "--")}</strong></div>
          <div class="devtool-detail-line"><span>SOURCE</span><strong>${app.esc(record.source || "--")}</strong></div>
          <div class="devtool-detail-line"><span>DURATION</span><strong>${app.esc(app.formatDuration(record.durationMs))}</strong></div>
          ${record.note ? `<div class="devtool-detail-text">${app.esc(record.note)}</div>` : ""}
          <pre class="devtool-report">${app.esc(app.formatJson(detailObject))}</pre>
        </div>
      `;
    }

    function renderExecutionRecord(record, selected) {
      const statusClass = app.normalizeStatusClass(record.executionStatus || record.status);
      const modeLabel = record.dryRun ? "DRY RUN" : "APPLY";
      const resultSummary = record.error
        ? String(record.error)
        : (record.result?.note || (record.result?.ok === true ? "ok" : "--"));
      return `
        <button class="devtool-case-row status-${app.esc(statusClass)} ${selected ? "selected" : ""}" data-execution-id="${app.esc(record.id)}">
          <div class="devtool-case-head">
            <span class="devtool-case-id">${app.esc(record.id || "--")}</span>
            <span class="devtool-case-status">${app.esc(record.executionStatus || record.status || "--")}</span>
          </div>
          <div class="devtool-case-meta">${app.esc(modeLabel)} // ${app.esc(record.surfaceId || "--")}</div>
          <div class="devtool-case-meta">${app.esc(app.formatTimestamp(record.finishedAt || record.startedAt))} // ${app.esc(app.formatDuration(record.durationMs))}</div>
          <div class="devtool-checkpoint-detail">${app.esc(resultSummary)}</div>
        </button>
      `;
    }

    function renderExecutionDetail(record, { latest = false } = {}) {
      if (!record) {
        return '<div class="devtool-empty compact">NO EXECUTION DETAIL</div>';
      }

      const detailObject = {
        id: record.id || null,
        surfaceId: record.surfaceId || null,
        dryRun: record.dryRun === true,
        status: record.status || null,
        executionStatus: record.executionStatus || null,
        note: record.note || null,
        startedAt: record.startedAt || null,
        finishedAt: record.finishedAt || null,
        durationMs: record.durationMs || null,
        payload: record.payload || null,
        result: record.result || null,
        error: record.error || null,
      };

      return `
        <div class="devtool-detail-card">
          <div class="devtool-detail-head">
            <span>${app.esc(latest ? "LATEST EXECUTION" : "SELECTED EXECUTION")}</span>
            <strong>${app.esc(record.executionStatus || record.status || "--")}</strong>
          </div>
          <div class="devtool-detail-line"><span>MODE</span><strong>${app.esc(record.dryRun ? "DRY RUN" : "APPLY")}</strong></div>
          <div class="devtool-detail-line"><span>FINISHED</span><strong>${app.esc(app.formatTimestamp(record.finishedAt || record.startedAt))}</strong></div>
          <div class="devtool-detail-line"><span>DURATION</span><strong>${app.esc(app.formatDuration(record.durationMs))}</strong></div>
          ${record.note ? `<div class="devtool-detail-text">${app.esc(record.note)}</div>` : ""}
          <pre class="devtool-report">${app.esc(app.formatJson(detailObject))}</pre>
        </div>
      `;
    }

    function renderRecommendedAction(action) {
      if (!action) {
        return '<div class="devtool-empty compact">NO RECOMMENDED NEXT HOP</div>';
      }

      const followUp = action.followUpSurfaceId
        ? `<div class="devtool-detail-line"><span>FOLLOW UP</span><strong>${app.esc(action.followUpSurfaceId)} ${app.esc(action.followUpMethod || "--")}</strong></div>`
        : "";

      return `
        <div class="devtool-detail-card">
          <div class="devtool-detail-head">
            <span>RECOMMENDED NEXT HOP</span>
            <strong>${app.esc(action.label || action.actionId || "--")}</strong>
          </div>
          <div class="devtool-detail-line"><span>SURFACE</span><strong>${app.esc(action.nextSurfaceId || "--")}</strong></div>
          <div class="devtool-detail-line"><span>METHOD</span><strong>${app.esc(action.nextMethod || "--")}</strong></div>
          ${followUp}
          ${action.summary ? `<div class="devtool-detail-text">${app.esc(action.summary)}</div>` : ""}
          <div class="devtool-inline-actions">
            <button class="devtool-btn compact" data-operator-next-hop="1">
              <span class="devtool-btn-title">${app.esc(action.nextMethod === "GET" ? "OPEN NEXT HOP" : "GO TO NEXT HOP")}</span>
              <span class="devtool-btn-desc">${app.esc(action.nextPath || action.nextSurfaceId || "--")}</span>
            </button>
          </div>
        </div>
      `;
    }

    function renderSnapshotWorkItemRows(items, emptyLabel) {
      const rows = Array.isArray(items) ? items : [];
      if (!rows.length) {
        return `<div class="devtool-empty compact">${app.esc(emptyLabel)}</div>`;
      }
      return rows.map((workItem) => `
        <div class="devtool-case-row status-${app.esc(app.normalizeStatusClass(workItem.status || "draft"))}">
          <div class="devtool-case-head">
            <span class="devtool-case-id">${app.esc(workItem.id || "--")}</span>
            <span class="devtool-case-status">${app.esc(workItem.status || "--")}</span>
          </div>
          <div class="devtool-case-meta">${app.esc(workItem.assignee || "--")} // ${app.esc(workItem.taskType || "--")}</div>
          <div class="devtool-checkpoint-detail">${app.esc(workItem.task || "--")}</div>
          <div class="devtool-inline-actions">
            <button class="devtool-btn compact" data-open-work-items-for="${app.esc(workItem.id || "")}">
              <span class="devtool-btn-title">OPEN WORK ITEMS</span>
              <span class="devtool-btn-desc">${app.esc(workItem.id || "--")}</span>
            </button>
          </div>
        </div>
      `).join("");
    }

    function renderSnapshotRuntimeReturns(items) {
      const rows = Array.isArray(items) ? items : [];
      if (!rows.length) {
        return '<div class="devtool-empty compact">NO ACTIVE DELIVERY TICKETS</div>';
      }
      return rows.map((ticket) => `
        <div class="devtool-case-row status-${app.esc(app.normalizeStatusClass(ticket.status || "draft"))}">
          <div class="devtool-case-head">
            <span class="devtool-case-id">${app.esc(ticket.id || "--")}</span>
            <span class="devtool-case-status">${app.esc(ticket.status || "--")}</span>
          </div>
          <div class="devtool-case-meta">${app.esc(ticket.lane || ticket.intentType || "--")} // ${app.esc(ticket.targetAgent || "--")}</div>
          <div class="devtool-checkpoint-detail">${app.esc(ticket.sourceAgentId || "--")} // ${app.esc(ticket.sourceContractId || "--")}</div>
          <div class="devtool-inline-actions">
            <button class="devtool-btn compact" data-open-delivery-tickets-for="${app.esc(ticket.id || "")}">
              <span class="devtool-btn-title">OPEN TICKETS</span>
              <span class="devtool-btn-desc">${app.esc(ticket.id || "--")}</span>
            </button>
          </div>
        </div>
      `).join("");
    }

    function renderSnapshotTestRuns(items) {
      const rows = Array.isArray(items) ? items : [];
      if (!rows.length) {
        return '<div class="devtool-empty compact">NO RELATED TEST RUNS</div>';
      }
      return rows.map((run) => `
        <button class="devtool-case-row status-${app.esc(app.normalizeStatusClass(run.status || "draft"))}" data-related-run-id="${app.esc(run.id || "")}">
          <div class="devtool-case-head">
            <span class="devtool-case-id">${app.esc(run.id || "--")}</span>
            <span class="devtool-case-status">${app.esc(run.status || "--")}</span>
          </div>
          <div class="devtool-case-meta">${app.esc(run.label || run.presetId || "--")} // ${app.esc(run.suite || "--")}</div>
          <div class="devtool-case-meta">${run.completedCases || 0}/${run.totalCases || 0} // ${run.failedCases || 0} FAIL // ${run.blockedCases || 0} BLOCKED</div>
        </button>
      `).join("");
    }

    function renderOperatorFrontDesk() {
      const snapshot = app.getOperatorSnapshot();
      if (!snapshot) {
        return '<div class="devtool-detail-card"><div class="devtool-empty compact">OPERATOR SNAPSHOT NOT AVAILABLE</div></div>';
      }

      const summary = snapshot.summary || {};
      const attention = app.getOperatorAttention().slice(0, 5);
      const workQueue = app.getOperatorWorkQueue().slice(0, 5);
      const attentionMarkup = attention.length
        ? attention.map((item) => `
            <div class="devtool-case-row status-${app.esc(item.severity === "error" ? "fail" : item.severity === "warning" ? "blocked" : "running")}">
              <div class="devtool-case-head">
                <span class="devtool-case-id">${app.esc(item.area || "--")}</span>
                <span class="devtool-case-status">${app.esc(item.count || 0)}</span>
              </div>
              <div class="devtool-checkpoint-detail">${app.esc(item.summary || "--")}</div>
              ${item.path
                ? `<div class="devtool-inline-actions">
                    <button class="devtool-btn compact" data-attention-path="${app.esc(item.path)}">
                      <span class="devtool-btn-title">OPEN</span>
                      <span class="devtool-btn-desc">${app.esc(item.path)}</span>
                    </button>
                  </div>`
                : ""}
            </div>
          `).join("")
        : '<div class="devtool-empty compact">NO ATTENTION ITEMS</div>';
      const queueMarkup = workQueue.length
        ? workQueue.map((item) => `
            <div class="devtool-case-row status-${app.esc(app.normalizeStatusClass(item.status || "draft"))}">
              <div class="devtool-case-head">
                <span class="devtool-case-id">${app.esc(item.title || item.draftId || "--")}</span>
                <span class="devtool-case-status">${app.esc(item.recommendedAction?.label || item.nextAction || "--")}</span>
              </div>
              <div class="devtool-case-meta">${app.esc(item.draftId || "--")} // ${app.esc(item.status || "--")}</div>
              <div class="devtool-case-meta">${item.related.failedWorkItemCount || 0} fail // ${item.related.activeWorkItemCount || 0} active // ${item.related.activeRuntimeReturnCount || 0} return // ${item.related.relatedTestRunCount || 0} test</div>
              <div class="devtool-inline-actions">
                <button class="devtool-btn compact" data-workqueue-draft-id="${app.esc(item.draftId)}">
                  <span class="devtool-btn-title">FOCUS DRAFT</span>
                  <span class="devtool-btn-desc">${app.esc(item.draftId || "--")}</span>
                </button>
                ${item.recommendedAction
                  ? `<button class="devtool-btn compact" data-workqueue-open-action="${app.esc(item.draftId)}">
                      <span class="devtool-btn-title">${app.esc(item.recommendedAction.nextMethod === "GET" ? "OPEN HOP" : "GO TO HOP")}</span>
                      <span class="devtool-btn-desc">${app.esc(item.recommendedAction.nextSurfaceId || "--")}</span>
                    </button>`
                  : ""}
              </div>
            </div>
          `).join("")
        : '<div class="devtool-empty compact">NO WORK QUEUE ITEMS</div>';

      return `
        <div class="devtool-detail-card">
          <div class="devtool-detail-head">
            <span>OPERATOR FRONT DESK</span>
            <strong>${app.esc(String(summary.state || "idle").toUpperCase())}</strong>
          </div>
          <div class="devtool-kv-grid compact">
            <div><span>ATTENTION</span><strong>${summary.attentionCount || 0}</strong></div>
            <div><span>ACTIVE WORK ITEMS</span><strong>${summary.activeWorkItems || 0}</strong></div>
            <div><span>ACTIVE RETURNS</span><strong>${summary.activeRuntimeReturns || 0}</strong></div>
            <div><span>TRACKING</span><strong>${summary.activeTrackingSessions || 0}</strong></div>
            <div><span>QUEUE</span><strong>${summary.queueDepth || 0}</strong></div>
            <div><span>ACTIVE RUN</span><strong>${app.esc(summary.activeTestRunId || "--")}</strong></div>
          </div>
          <div class="devtool-section-title">ATTENTION</div>
          <div class="devtool-case-list">${attentionMarkup}</div>
          <div class="devtool-section-title">WORK QUEUE</div>
          <div class="devtool-case-list">${queueMarkup}</div>
        </div>
      `;
    }

    function getRelatedRuntimeReturnTickets(draft, execution) {
      if (!draft) return [];
      const selectedExecutionId = execution?.id || null;
      const draftId = draft.id || null;
      const matches = (Array.isArray(app.state.systemActionDeliveryTickets) ? app.state.systemActionDeliveryTickets : [])
        .filter((ticket) => {
          const metadata = ticket?.metadata && typeof ticket.metadata === "object" ? ticket.metadata : {};
          if (selectedExecutionId && metadata.originExecutionId === selectedExecutionId) {
            return true;
          }
          return draftId && metadata.originDraftId === draftId;
        })
        .sort((left, right) => (Number(right?.createdAt) || 0) - (Number(left?.createdAt) || 0));

      if (!selectedExecutionId) {
        return matches;
      }

      return matches.sort((left, right) => {
        const leftExact = left?.metadata?.originExecutionId === selectedExecutionId;
        const rightExact = right?.metadata?.originExecutionId === selectedExecutionId;
        if (leftExact !== rightExact) {
          return leftExact ? -1 : 1;
        }
        return (Number(right?.createdAt) || 0) - (Number(left?.createdAt) || 0);
      });
    }

    function renderRelatedRuntimeReturns(draft, execution) {
      const tickets = getRelatedRuntimeReturnTickets(draft, execution);
      if (!tickets.length) {
        return '<div class="devtool-empty compact">NO RELATED DELIVERY TICKETS</div>';
      }

      return tickets.map((ticket) => {
        const metadata = ticket?.metadata && typeof ticket.metadata === "object" ? ticket.metadata : {};
        const targetAgent = ticket?.route?.targetAgent || ticket?.route?.replyTo?.agentId || "--";
        const originExecutionId = metadata.originExecutionId || "--";
        return `
          <div class="devtool-case-row status-${app.esc(app.normalizeStatusClass(ticket.status || "draft"))}">
            <div class="devtool-case-head">
              <span class="devtool-case-id">${app.esc(ticket.id || "--")}</span>
              <span class="devtool-case-status">${app.esc(ticket.status || "--")}</span>
            </div>
            <div class="devtool-case-meta">${app.esc(ticket.lane || ticket.intentType || "--")} // ${app.esc(targetAgent)}</div>
            <div class="devtool-case-meta">${app.esc(metadata.originDraftId || "--")} // ${app.esc(originExecutionId)}</div>
            <div class="devtool-checkpoint-detail">${app.esc(ticket.source?.agentId || "--")} // ${app.esc(ticket.source?.contractId || "--")}</div>
            <div class="devtool-inline-actions">
              <button class="devtool-btn compact" data-open-delivery-tickets-for="${app.esc(ticket.id || "")}">
                <span class="devtool-btn-title">OPEN TICKETS</span>
                <span class="devtool-btn-desc">${app.esc(ticket.id || "--")}</span>
              </button>
            </div>
          </div>
        `;
      }).join("");
    }

    function renderChangeSetDetail() {
      const draft = app.state.selectedDraft;
      const snapshotDraft = app.getOperatorSelectedDraftSummary();
      if (!draft) {
        return '<div class="devtool-empty">NO CHANGE SET YET<br>CREATE OR LOAD A DRAFT TO INSPECT IT HERE.</div>';
      }

      const verificationHistory = Array.isArray(draft.verificationHistory) ? draft.verificationHistory : [];
      const executionHistory = Array.isArray(draft.executionHistory) ? draft.executionHistory : [];
      const selectedVerification = verificationHistory.find((item) => item.id === app.state.selectedVerificationId) || verificationHistory[0] || null;
      const latestVerificationId = verificationHistory[0]?.id || null;
      const selectedExecution = executionHistory.find((item) => item.id === app.state.selectedExecutionId) || executionHistory[0] || null;
      const latestExecutionId = executionHistory[0]?.id || null;
      const verificationRows = verificationHistory.map((item) => (
        renderVerificationRecord(item, item.id === (selectedVerification?.id || ""))
      )).join("");
      const executionRows = executionHistory.map((item) => (
        renderExecutionRecord(item, item.id === (selectedExecution?.id || ""))
      )).join("");
      const planningCards = [
        app.renderDetailCard("CHANGE SET", draft.changeSet),
        app.renderDetailCard("VERIFICATION PLAN", draft.verificationPlan),
      ].filter(Boolean).join("");
      const managementContext = app.getSelectedDraftManagementContext();
      const statusClass = app.normalizeStatusClass(draft.lastVerificationStatus || draft.status);

      return `
        <div class="devtool-summary-head">
          <div>
            <div class="devtool-run-label">${app.esc(draft.title || draft.surfaceId || draft.id)}</div>
            <div class="devtool-run-id">${app.esc(draft.id)}</div>
          </div>
          <div class="devtool-run-status status-${app.esc(statusClass)}">${app.esc(draft.lastVerificationStatus || draft.status || "draft")}</div>
        </div>
        <div class="devtool-kv-grid">
          <div><span>SURFACE</span><strong>${app.esc(draft.surfaceId || "--")}</strong></div>
          <div><span>PHASE</span><strong>${app.esc(draft.operatorPhase || "--")}</strong></div>
          <div><span>STAGE</span><strong>${app.esc(draft.stage || "--")}</strong></div>
          <div><span>RISK</span><strong>${app.esc(draft.riskLevel || "--")}</strong></div>
          <div><span>METHOD</span><strong>${app.esc(draft.surfaceMethod || "--")} ${app.esc(draft.surfacePath || "")}</strong></div>
          <div><span>CONFIRM</span><strong>${app.esc(draft.confirmation || "--")}</strong></div>
          <div><span>EXECUTIONS</span><strong>${draft.executionCount || 0}</strong></div>
          <div><span>LAST EXEC</span><strong>${app.esc(draft.lastExecutionStatus || "--")}</strong></div>
          <div><span>VERIFICATIONS</span><strong>${draft.verificationCount || 0}</strong></div>
          <div><span>UPDATED</span><strong>${app.esc(app.formatTimestamp(draft.updatedAt))}</strong></div>
        </div>
        ${draft.summary ? `<div class="devtool-note">${app.esc(draft.summary)}</div>` : ""}
        ${app.renderManagementContextCard(managementContext, { title: "DRAFT TARGET", action: "return" })}
        ${renderRecommendedAction(snapshotDraft?.recommendedAction || null)}
        <div class="devtool-section-title">RELATED ACTIVE WORK ITEMS</div>
        <div class="devtool-case-list">${renderSnapshotWorkItemRows(snapshotDraft?.related?.activeWorkItems, "NO ACTIVE RELATED WORK ITEMS")}</div>
        <div class="devtool-section-title">RELATED FAILED WORK ITEMS</div>
        <div class="devtool-case-list">${renderSnapshotWorkItemRows(snapshotDraft?.related?.failedWorkItems, "NO FAILED RELATED WORK ITEMS")}</div>
        <div class="devtool-section-title">EXECUTION HISTORY</div>
        <div class="devtool-case-list">${executionRows || '<div class="devtool-empty compact">NO EXECUTION HISTORY YET.</div>'}</div>
        ${renderExecutionDetail(selectedExecution, { latest: selectedExecution?.id === latestExecutionId })}
        <div class="devtool-section-title">RELATED RUNTIME RETURNS</div>
        <div class="devtool-case-list">${snapshotDraft?.related?.activeRuntimeReturns?.length
          ? renderSnapshotRuntimeReturns(snapshotDraft.related.activeRuntimeReturns)
          : renderRelatedRuntimeReturns(draft, selectedExecution)}</div>
        <div class="devtool-section-title">RELATED TEST RUNS</div>
        <div class="devtool-case-list">${renderSnapshotTestRuns(snapshotDraft?.related?.recentTestRuns)}</div>
        <div class="devtool-section-title">VERIFICATION HISTORY</div>
        <div class="devtool-case-list">${verificationRows || '<div class="devtool-empty compact">NO VERIFICATION EVIDENCE LINKED YET.</div>'}</div>
        ${renderVerificationDetail(selectedVerification, { latest: selectedVerification?.id === latestVerificationId })}
        ${planningCards ? `<div class="devtool-section-title">PLANNING OBJECTS</div><div class="devtool-runtime-grid">${planningCards}</div>` : ""}
      `;
    }

    function renderComposeField(field) {
      const rawValue = app.state.composeFieldValues[field.key];
      const value = field.type === "checkbox_group" ? rawValue : String(rawValue ?? "");
      const options = app.getFieldOptions(field);
      const label = field.required ? `${field.label || field.key} *` : (field.label || field.key);
      const help = field.description
        ? `<div class="devtool-field-help">${app.esc(field.description)}</div>`
        : "";

      if (field.type === "checkbox_group") {
        const selected = new Set(Array.isArray(rawValue) ? rawValue : []);
        const rows = options.map((option, index) => `
          <label class="devtool-checkbox-item" for="composeField-${app.esc(field.key)}-${index}">
            <input
              id="composeField-${app.esc(field.key)}-${index}"
              type="checkbox"
              data-compose-field="${app.esc(field.key)}"
              value="${app.esc(option.value)}"
              ${selected.has(option.value) ? "checked" : ""}
            >
            <span class="devtool-checkbox-copy">
              <strong>${app.esc(option.label || option.value)}</strong>
              ${option.detail ? `<small>${app.esc(option.detail)}</small>` : ""}
            </span>
          </label>
        `).join("");

        return `
          <div class="devtool-field-shell">
            <label class="devtool-form-label">${app.esc(label)}</label>
            <div class="devtool-checkbox-grid">
              ${rows || '<div class="devtool-empty compact">NO OPTIONS AVAILABLE</div>'}
            </div>
            ${help}
          </div>
        `;
      }

      if (field.type === "select") {
        const selectOptions = [...options];
        if (!selectOptions.some((option) => String(option.value ?? "") === "") && field.defaultValue === undefined) {
          selectOptions.unshift({
            value: "",
            label: field.placeholder || `Select ${field.label || field.key}`,
          });
        }
        const optionMarkup = selectOptions.map((option) => {
          const optionLabel = option.detail
            ? `${option.label || option.value} :: ${option.detail}`
            : (option.label || option.value);
          return `<option value="${app.esc(option.value)}" ${String(option.value ?? "") === value ? "selected" : ""}>${app.esc(optionLabel)}</option>`;
        }).join("");
        return `
          <div class="devtool-field-shell">
            <label class="devtool-form-label" for="composeField-${app.esc(field.key)}">${app.esc(label)}</label>
            <select class="devtool-form-control" id="composeField-${app.esc(field.key)}" data-compose-field="${app.esc(field.key)}">
              ${optionMarkup}
            </select>
            ${help}
          </div>
        `;
      }

      if (field.type === "combo") {
        const datalistId = `composeFieldList-${field.key}`;
        const optionMarkup = options.map((option) => (
          `<option value="${app.esc(option.value)}">${app.esc(option.detail ? `${option.label || option.value} :: ${option.detail}` : (option.label || option.value))}</option>`
        )).join("");
        return `
          <div class="devtool-field-shell">
            <label class="devtool-form-label" for="composeField-${app.esc(field.key)}">${app.esc(label)}</label>
            <input
              class="devtool-form-control"
              id="composeField-${app.esc(field.key)}"
              data-compose-field="${app.esc(field.key)}"
              type="text"
              list="${app.esc(datalistId)}"
              value="${app.esc(value)}"
              ${field.placeholder ? `placeholder="${app.esc(field.placeholder)}"` : ""}
              ${field.inputMode ? `inputmode="${app.esc(field.inputMode)}"` : ""}
            >
            <datalist id="${app.esc(datalistId)}">${optionMarkup}</datalist>
            ${help}
          </div>
        `;
      }

      if (field.type === "textarea") {
        return `
          <div class="devtool-field-shell">
            <label class="devtool-form-label" for="composeField-${app.esc(field.key)}">${app.esc(label)}</label>
            <textarea
              class="devtool-form-control devtool-form-textarea compact"
              id="composeField-${app.esc(field.key)}"
              data-compose-field="${app.esc(field.key)}"
              ${field.placeholder ? `placeholder="${app.esc(field.placeholder)}"` : ""}
            >${app.esc(value)}</textarea>
            ${help}
          </div>
        `;
      }

      return `
        <div class="devtool-field-shell">
          <label class="devtool-form-label" for="composeField-${app.esc(field.key)}">${app.esc(label)}</label>
          <input
            class="devtool-form-control"
            id="composeField-${app.esc(field.key)}"
            data-compose-field="${app.esc(field.key)}"
            type="text"
            value="${app.esc(value)}"
            ${field.placeholder ? `placeholder="${app.esc(field.placeholder)}"` : ""}
            ${field.inputMode ? `inputmode="${app.esc(field.inputMode)}"` : ""}
          >
          ${help}
        </div>
      `;
    }

    function renderComposeFieldSection(surface) {
      const fields = app.getSurfaceInputFields(surface);
      if (!fields.length) return "";
      return `
        <div class="devtool-section-title">STRUCTURED INPUTS</div>
        <div class="devtool-form-grid">
          ${fields.map((field) => renderComposeField(field)).join("")}
        </div>
      `;
    }

    function readComposeFieldValue(field) {
      if (field.type === "checkbox_group") {
        return [...document.querySelectorAll(`[data-compose-field="${field.key}"]`)]
          .filter((node) => node.checked)
          .map((node) => node.value);
      }
      const input = document.querySelector(`[data-compose-field="${field.key}"]`);
      return input ? input.value : app.normalizeFieldValueForState(field, undefined);
    }

    function bindComposeFieldInputs(surface) {
      for (const field of app.getSurfaceInputFields(surface)) {
        const handler = () => {
          app.state.composeFieldValues[field.key] = readComposeFieldValue(field);
          if (field.key === "agentId") {
            app.refillComposerForCurrentTarget(surface, { agentIdHint: app.state.composeFieldValues[field.key] });
            app.renderDevtools();
            return;
          }
          app.syncComposePayloadTextFromFields();
        };
        const selector = `[data-compose-field="${field.key}"]`;
        const controls = [...document.querySelectorAll(selector)];
        for (const control of controls) {
          control.addEventListener(field.type === "checkbox_group" || field.type === "select" ? "change" : "input", handler);
          if (field.type !== "checkbox_group" && field.type !== "select") {
            control.addEventListener("change", handler);
          }
        }
      }
    }

    function renderActions() {
      const host = document.getElementById("testDevtoolActions");
      if (!host) return;

      const counts = app.state.adminSurfaceSummary?.counts || {};
      const selectedRunSummary = app.state.runs.find((item) => item.id === app.state.selectedRunId) || null;
      const selectedDraft = app.state.changeSets.find((item) => item.id === app.state.selectedDraftId) || null;
      const selectedDraftDetail = app.state.selectedDraft?.id === app.state.selectedDraftId
        ? app.state.selectedDraft
        : null;
      const authoringSurfaces = app.getAuthoringSurfaces();
      const executeBusy = !!app.state.executingDraftAction;
      const canExecuteDraft = !!selectedDraft && !executeBusy;
      const canSaveDraft = !!app.state.composeSurfaceId && !app.state.savingDraft;
      const selectedComposeSurface = app.findAuthoringSurface(app.state.composeSurfaceId);
      const composerContext = app.getComposerManagementContext();
      const draftContext = app.getSelectedDraftManagementContext();
      const composeFieldSection = renderComposeFieldSection(selectedComposeSurface);
      const verification = app.getDraftVerificationRunConfig(selectedDraftDetail);
      const relatedRuns = app.state.runs
        .filter((run) => run.originDraftId && run.originDraftId === selectedDraftDetail?.id)
        .sort((left, right) => (
          (Number(right.startedAt) || Number(right.finishedAt) || 0)
          - (Number(left.startedAt) || Number(left.finishedAt) || 0)
        ));
      const latestRelatedRun = relatedRuns[0] || null;
      const latestFinishedRelatedRun = relatedRuns.find((run) => run.finishedAt && !run.active) || null;
      const selectedRunMatchesDraft = Boolean(
        selectedRunSummary
        && selectedDraftDetail
        && selectedRunSummary.originDraftId === selectedDraftDetail.id,
      );
      const preferredEvidenceRun = selectedRunMatchesDraft
        ? selectedRunSummary
        : (latestFinishedRelatedRun || latestRelatedRun || selectedRunSummary);
      const evidenceRunSource = selectedRunMatchesDraft
        ? "CURRENT"
        : (preferredEvidenceRun?.originDraftId === selectedDraftDetail?.id ? "RELATED" : "GLOBAL");
      const verificationHistoryRunIds = new Set(
        (Array.isArray(selectedDraftDetail?.verificationHistory) ? selectedDraftDetail.verificationHistory : [])
          .map((item) => item?.runId)
          .filter(Boolean),
      );
      const canLink = Boolean(
        preferredEvidenceRun
        && preferredEvidenceRun.finishedAt
        && !preferredEvidenceRun.active
        && !verificationHistoryRunIds.has(preferredEvidenceRun.id)
        && selectedDraft
        && !app.state.linkingVerification,
      );
      const canStartRecommendedVerify = Boolean(
        selectedDraftDetail
        && verification?.draftId
        && verification?.presetId
        && verification?.supported !== false
        && verification?.enabled !== false
        && !app.state.activeRunId
        && !app.state.startingPresetId,
      );
      const canLinkLatestRelatedRun = Boolean(
        selectedDraftDetail
        && latestRelatedRun
        && latestRelatedRun.finishedAt
        && !latestRelatedRun.active
        && !verificationHistoryRunIds.has(latestRelatedRun.id)
        && !app.state.linkingVerification,
      );
      const composeSurfaceOptions = authoringSurfaces.map((surface) => `
        <option value="${app.esc(surface.id)}" ${surface.id === app.state.composeSurfaceId ? "selected" : ""}>
          ${app.esc(surface.id)} :: ${app.esc(surface.risk)}
        </option>
      `).join("");

      host.innerHTML = `
        <div class="devtool-detail-card">
          <div class="devtool-detail-head">
            <span>ADMIN SURFACES</span>
            <strong>${app.esc(counts.total || 0)}</strong>
          </div>
          <div class="devtool-kv-grid compact">
            <div><span>INSPECT</span><strong>${counts.inspect || 0}</strong></div>
            <div><span>APPLY</span><strong>${counts.apply || 0}</strong></div>
            <div><span>VERIFY</span><strong>${counts.verify || 0}</strong></div>
            <div><span>HOLD</span><strong>${counts.hold || 0}</strong></div>
          </div>
        </div>
        ${app.renderManagementContextCard(composerContext || draftContext, { title: "ACTIVE MANAGEMENT TARGET", action: "return" })}
        <div class="devtool-detail-card">
          <div class="devtool-detail-head">
            <span>DRAFT AUTHORING</span>
            <strong>${app.esc(app.state.composeDraftId || "NEW")}</strong>
          </div>
          <label class="devtool-form-label" for="composeSurfaceSelect">SURFACE</label>
          <select class="devtool-form-control" id="composeSurfaceSelect">
            ${composeSurfaceOptions || '<option value="">NO ACTIVE APPLY SURFACES</option>'}
          </select>
          <label class="devtool-form-label" for="composeTitleInput">TITLE</label>
          <input class="devtool-form-control" id="composeTitleInput" type="text" value="${app.esc(app.state.composeTitle)}" placeholder="Draft title">
          <label class="devtool-form-label" for="composeSummaryInput">SUMMARY</label>
          <textarea class="devtool-form-control devtool-form-textarea compact" id="composeSummaryInput" placeholder="Optional note for this draft">${app.esc(app.state.composeSummary)}</textarea>
          ${composeFieldSection}
          <label class="devtool-form-label" for="composePayloadInput">PAYLOAD JSON</label>
          <textarea class="devtool-form-control devtool-form-textarea" id="composePayloadInput" spellcheck="false">${app.esc(app.state.composePayloadText)}</textarea>
          <div class="devtool-detail-line"><span>SUBJECT</span><strong>${app.esc(composerContext?.subjectLabel || "--")}</strong></div>
          <div class="devtool-detail-line"><span>TARGET</span><strong>${app.esc(composerContext?.targetLabel || composerContext?.targetId || "--")}</strong></div>
          <div class="devtool-detail-line"><span>SURFACE</span><strong>${app.esc(selectedComposeSurface?.summary || "--")}</strong></div>
          <div class="devtool-detail-line"><span>CONFIRM</span><strong>${app.esc(selectedComposeSurface?.confirmation || "--")}</strong></div>
          <div class="devtool-note">Use structured inputs for the common path, or edit payload JSON directly for extra keys. JSON changes sync back into the structured fields when the editor loses focus.</div>
          <div class="devtool-inline-actions">
            <button class="devtool-btn compact" id="composeNewDraftButton" ${authoringSurfaces.length ? "" : "disabled"}>
              <span class="devtool-btn-title">NEW DRAFT</span>
              <span class="devtool-btn-desc">Reset composer for the selected surface.</span>
            </button>
            <button class="devtool-btn compact" id="composeLoadSelectedButton" ${selectedDraft ? "" : "disabled"}>
              <span class="devtool-btn-title">LOAD SELECTED</span>
              <span class="devtool-btn-desc">Load the selected draft into the composer.</span>
            </button>
          </div>
          <button class="devtool-btn ${app.state.savingDraft ? "busy" : ""}" id="composeSaveDraftButton" ${canSaveDraft ? "" : "disabled"}>
            <span class="devtool-btn-title">${app.state.savingDraft ? "SAVING..." : (app.state.composeDraftId ? "UPDATE DRAFT" : "SAVE DRAFT")}</span>
            <span class="devtool-btn-desc">Persist the composed payload as a change-set draft.</span>
          </button>
        </div>
        <div class="devtool-detail-card">
          <div class="devtool-detail-head">
            <span>LINK EVIDENCE</span>
            <strong>${app.esc(selectedDraft?.id || "--")}</strong>
          </div>
          <div class="devtool-detail-line"><span>DRAFT</span><strong>${app.esc(selectedDraft?.title || selectedDraft?.surfaceId || "--")}</strong></div>
          <div class="devtool-detail-line"><span>RUN</span><strong>${app.esc(preferredEvidenceRun?.id || "--")}</strong></div>
          <div class="devtool-detail-line"><span>RUN STATUS</span><strong>${app.esc(preferredEvidenceRun?.status || "--")}</strong></div>
          <div class="devtool-detail-line"><span>RUN SOURCE</span><strong>${app.esc(preferredEvidenceRun ? evidenceRunSource : "--")}</strong></div>
          <div class="devtool-detail-line"><span>LAST VERIFY</span><strong>${app.esc(selectedDraft?.lastVerificationStatus || "--")}</strong></div>
          <div class="devtool-note">This card now prefers the latest completed run already bound to the current draft. If none exists, it falls back to the globally selected run.</div>
          <button class="devtool-btn devtool-link-btn ${app.state.linkingVerification ? "busy" : ""}" id="linkSelectedRunButton" ${canLink ? "" : "disabled"}>
            <span class="devtool-btn-title">${app.state.linkingVerification ? "LINKING..." : "LINK EVIDENCE RUN"}</span>
            <span class="devtool-btn-desc">${app.esc(preferredEvidenceRun ? `Bind ${preferredEvidenceRun.id} into verification history.` : "no attachable run available")}</span>
          </button>
        </div>
        <div class="devtool-detail-card">
          <div class="devtool-detail-head">
            <span>VERIFY DRAFT</span>
            <strong>${app.esc(selectedDraftDetail?.id || "--")}</strong>
          </div>
          <div class="devtool-detail-line"><span>PRESET</span><strong>${app.esc(verification?.presetId || "--")}</strong></div>
          <div class="devtool-detail-line"><span>CLEAN MODE</span><strong>${app.esc(verification?.cleanMode || "--")}</strong></div>
          <div class="devtool-detail-line"><span>EXECUTION</span><strong>${app.esc(verification?.executionId || verification?.executionStatus || "--")}</strong></div>
          <div class="devtool-detail-line"><span>LATEST RUN</span><strong>${app.esc(latestRelatedRun?.id || "--")}</strong></div>
          <div class="devtool-detail-line"><span>LATEST STATUS</span><strong>${app.esc(latestRelatedRun?.status || "--")}</strong></div>
          <div class="devtool-note">Start the recommended verification run directly from the current draft, or bind the latest related run back as evidence when it has already finished.</div>
          <div class="devtool-inline-actions">
            <button class="devtool-btn compact ${app.state.startingPresetId === (verification?.presetId || "") ? "busy" : ""}" id="startRecommendedVerifyButton" ${canStartRecommendedVerify ? "" : "disabled"}>
              <span class="devtool-btn-title">${app.state.startingPresetId === (verification?.presetId || "") ? "STARTING..." : "START RECOMMENDED VERIFY"}</span>
              <span class="devtool-btn-desc">${app.esc(verification?.presetId ? `${verification.presetId} // ${verification.cleanMode}` : "verification run unavailable")}</span>
            </button>
            <button class="devtool-btn compact" id="openLatestRelatedRunButton" ${latestRelatedRun ? "" : "disabled"}>
              <span class="devtool-btn-title">OPEN LATEST RUN</span>
              <span class="devtool-btn-desc">${app.esc(latestRelatedRun?.id || "--")}</span>
            </button>
          </div>
          <button class="devtool-btn compact ${app.state.linkingVerification ? "busy" : ""}" id="linkLatestRelatedRunButton" ${canLinkLatestRelatedRun ? "" : "disabled"}>
            <span class="devtool-btn-title">${app.state.linkingVerification ? "LINKING..." : "LINK LATEST RELATED RUN"}</span>
            <span class="devtool-btn-desc">${app.esc(latestRelatedRun ? `Bind ${latestRelatedRun.id} into verification history.` : "no finished related run available")}</span>
          </button>
        </div>
        <div class="devtool-detail-card">
          <div class="devtool-detail-head">
            <span>EXECUTE DRAFT</span>
            <strong>${app.esc(selectedDraft?.id || "--")}</strong>
          </div>
          <div class="devtool-detail-line"><span>SURFACE</span><strong>${app.esc(selectedDraft?.surfaceId || "--")}</strong></div>
          <div class="devtool-detail-line"><span>CONFIRM</span><strong>${app.esc(selectedDraft?.confirmation || "--")}</strong></div>
          <div class="devtool-detail-line"><span>STATUS</span><strong>${app.esc(selectedDraft?.status || "--")}</strong></div>
          <div class="devtool-note">Dry run records a preview execution. Apply executes the selected draft. Explicit surfaces will prompt for confirmation.</div>
          <button class="devtool-btn ${app.state.executingDraftAction === "dry-run" ? "busy" : ""}" id="dryRunDraftButton" ${canExecuteDraft ? "" : "disabled"}>
            <span class="devtool-btn-title">${app.state.executingDraftAction === "dry-run" ? "PREVIEWING..." : "DRY RUN"}</span>
            <span class="devtool-btn-desc">Record a preview-only execution for the selected draft.</span>
          </button>
          <button class="devtool-btn ${app.state.executingDraftAction === "execute" ? "busy" : ""}" id="executeDraftButton" ${canExecuteDraft ? "" : "disabled"}>
            <span class="devtool-btn-title">${app.state.executingDraftAction === "execute" ? "EXECUTING..." : "EXECUTE DRAFT"}</span>
            <span class="devtool-btn-desc">Apply the selected draft through admin-change-set executor.</span>
          </button>
        </div>
      `;

      const button = document.getElementById("linkSelectedRunButton");
      if (button) {
        button.addEventListener("click", () => {
          if (!selectedDraft?.id || !preferredEvidenceRun?.id) return;
          void app.attachRunToDraft({
            draftId: selectedDraft.id,
            runId: preferredEvidenceRun.id,
            note: "linked from CHANGE SETS evidence card",
          });
        });
      }
      const startRecommendedVerifyButton = document.getElementById("startRecommendedVerifyButton");
      if (startRecommendedVerifyButton) {
        startRecommendedVerifyButton.addEventListener("click", () => {
          if (!verification?.presetId || !verification?.draftId) return;
          void app.startPreset(verification.presetId, {
            cleanMode: verification.cleanMode,
            originDraftId: verification.draftId,
            originExecutionId: verification.executionId,
            originSurfaceId: verification.surfaceId,
            openRunAfterStart: true,
          });
        });
      }
      const openLatestRelatedRunButton = document.getElementById("openLatestRelatedRunButton");
      if (openLatestRelatedRunButton) {
        openLatestRelatedRunButton.addEventListener("click", () => {
          if (!latestRelatedRun?.id) return;
          app.openRunInTestRuns(latestRelatedRun.id);
        });
      }
      const linkLatestRelatedRunButton = document.getElementById("linkLatestRelatedRunButton");
      if (linkLatestRelatedRunButton) {
        linkLatestRelatedRunButton.addEventListener("click", () => {
          if (!selectedDraftDetail?.id || !latestRelatedRun?.id) return;
          void app.attachRunToDraft({
            draftId: selectedDraftDetail.id,
            runId: latestRelatedRun.id,
            note: "linked from CHANGE SETS latest related run",
          });
        });
      }
      const composeSurfaceSelect = document.getElementById("composeSurfaceSelect");
      if (composeSurfaceSelect) {
        composeSurfaceSelect.addEventListener("change", (event) => {
          app.resetComposerForSurface(event.target.value);
          app.renderDevtools();
        });
      }
      const composeTitleInput = document.getElementById("composeTitleInput");
      if (composeTitleInput) {
        composeTitleInput.addEventListener("input", (event) => {
          app.state.composeTitle = event.target.value;
        });
      }
      const composeSummaryInput = document.getElementById("composeSummaryInput");
      if (composeSummaryInput) {
        composeSummaryInput.addEventListener("input", (event) => {
          app.state.composeSummary = event.target.value;
        });
      }
      bindComposeFieldInputs(selectedComposeSurface);
      const composePayloadInput = document.getElementById("composePayloadInput");
      if (composePayloadInput) {
        composePayloadInput.addEventListener("input", (event) => {
          app.state.composePayloadText = event.target.value;
        });
        composePayloadInput.addEventListener("change", (event) => {
          app.state.composePayloadText = event.target.value;
          if (app.syncComposeFieldsFromPayloadText()) {
            app.renderDevtools();
          }
        });
      }
      const composeNewDraftButton = document.getElementById("composeNewDraftButton");
      if (composeNewDraftButton) {
        composeNewDraftButton.addEventListener("click", () => {
          app.resetComposerForSurface(app.state.composeSurfaceId);
          app.renderDevtools();
        });
      }
      const composeLoadSelectedButton = document.getElementById("composeLoadSelectedButton");
      if (composeLoadSelectedButton) {
        composeLoadSelectedButton.addEventListener("click", () => {
          app.loadComposerFromDraft(app.state.selectedDraft);
          app.renderDevtools();
        });
      }
      const composeSaveDraftButton = document.getElementById("composeSaveDraftButton");
      if (composeSaveDraftButton) {
        composeSaveDraftButton.addEventListener("click", () => { void app.saveComposerDraft(); });
      }
      const dryRunButton = document.getElementById("dryRunDraftButton");
      if (dryRunButton) {
        dryRunButton.addEventListener("click", () => { void app.executeSelectedDraft({ dryRun: true }); });
      }
      const executeButton = document.getElementById("executeDraftButton");
      if (executeButton) {
        executeButton.addEventListener("click", () => { void app.executeSelectedDraft({ dryRun: false }); });
      }
      host.querySelectorAll("[data-return-to-management]").forEach((button) => {
        button.addEventListener("click", () => app.returnToManagementView());
      });
    }

    function renderSummary(errorMessage) {
      const host = document.getElementById("testDevtoolSummary");
      if (!host) return;
      if (errorMessage) {
        host.innerHTML = `<div class="devtool-empty">LOAD ERROR<br>${app.esc(errorMessage)}</div>`;
        return;
      }
      host.innerHTML = `${renderOperatorFrontDesk()}${renderChangeSetDetail()}`;

      host.querySelectorAll("[data-verification-id]").forEach((button) => {
        button.addEventListener("click", () => app.selectVerification(button.getAttribute("data-verification-id")));
      });
      host.querySelectorAll("[data-execution-id]").forEach((button) => {
        button.addEventListener("click", () => app.selectExecution(button.getAttribute("data-execution-id")));
      });
      host.querySelectorAll("[data-return-to-management]").forEach((button) => {
        button.addEventListener("click", () => app.returnToManagementView());
      });
      host.querySelectorAll("[data-operator-next-hop]").forEach((button) => {
        button.addEventListener("click", () => {
          const action = app.getOperatorSelectedDraftSummary()?.recommendedAction || null;
          app.openOperatorRecommendedAction(action);
        });
      });
      host.querySelectorAll("[data-workqueue-draft-id]").forEach((button) => {
        button.addEventListener("click", () => app.selectDraft(button.getAttribute("data-workqueue-draft-id")));
      });
      host.querySelectorAll("[data-workqueue-open-action]").forEach((button) => {
        button.addEventListener("click", () => {
          const draftId = button.getAttribute("data-workqueue-open-action");
          const item = app.getOperatorWorkQueue().find((entry) => entry.draftId === draftId);
          app.openOperatorRecommendedAction(item?.recommendedAction || null);
        });
      });
      host.querySelectorAll("[data-attention-path]").forEach((button) => {
        button.addEventListener("click", () => app.openTokenizedPath(button.getAttribute("data-attention-path")));
      });
      host.querySelectorAll("[data-related-run-id]").forEach((button) => {
        button.addEventListener("click", () => app.openRunInTestRuns(button.getAttribute("data-related-run-id")));
      });
      host.querySelectorAll("[data-open-work-items-for]").forEach((button) => {
        button.addEventListener("click", () => app.openTokenizedPath("/watchdog/work-items"));
      });
      host.querySelectorAll("[data-open-delivery-tickets-for]").forEach((button) => {
        button.addEventListener("click", () => app.openTokenizedPath("/watchdog/system-action-delivery-tickets"));
      });
    }

    function renderHistory() {
      const host = document.getElementById("testDevtoolHistory");
      if (!host) return;
      const recentDrafts = app.getOperatorRecentDrafts();
      let historyDrafts = recentDrafts.length
        ? [...recentDrafts]
        : [...app.state.changeSets];
      if (app.state.selectedDraft && !historyDrafts.some((draft) => draft.id === app.state.selectedDraft.id)) {
        historyDrafts = [app.state.selectedDraft, ...historyDrafts];
      }
      if (!historyDrafts.length) {
        host.innerHTML = '<div class="devtool-empty">DRAFT HISTORY EMPTY</div>';
        return;
      }

      host.innerHTML = historyDrafts.map((draft) => {
        const statusClass = app.normalizeStatusClass(draft.lastVerificationStatus || draft.status);
        const title = draft.title || draft.surfaceId || draft.id;
        return `
          <button class="devtool-history-item status-${app.esc(statusClass)} ${app.state.selectedDraftId === draft.id ? "selected" : ""}" data-draft-id="${app.esc(draft.id)}">
            <div class="devtool-history-head">
              <span>${app.esc(title)}</span>
              <span class="status-${app.esc(statusClass)}">${app.esc(draft.lastVerificationStatus || draft.status || "draft")}</span>
            </div>
            <div class="devtool-history-meta">${app.esc(draft.surfaceId || "--")}</div>
            <div class="devtool-history-meta">${app.esc(draft.recommendedAction?.label || draft.nextAction || "--")}</div>
            <div class="devtool-history-meta">${draft.related?.failedWorkItemCount || 0} fail // ${draft.related?.activeWorkItemCount || 0} active // ${draft.related?.activeRuntimeReturnCount || 0} return // ${app.esc(app.formatTimestamp(draft.updatedAt || draft.lastVerificationAt || draft.lastExecutionAt))}</div>
          </button>
        `;
      }).join("");

      host.querySelectorAll("[data-draft-id]").forEach((button) => {
        button.addEventListener("click", () => app.selectDraft(button.getAttribute("data-draft-id")));
      });
    }

    return {
      renderActions,
      renderSummary,
      renderHistory,
      readComposeFieldValue,
    };
  };
})();
