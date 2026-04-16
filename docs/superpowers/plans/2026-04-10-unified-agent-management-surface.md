# Unified Agent Management Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 保留主页面快捷操作和 Agents 页面完整管理，同时把 `role`、`delete`、`hard delete` 的后端语义、落盘行为、确认文案、前端刷新全部统一成一套系统真值。

**Architecture:** 后端新增 `agents.hard_delete` 作为唯一新的破坏性操作；`create / join / delete / hard_delete` 都走同一套 agent-admin core。前端保留两层壳：主拓扑页只做快捷创建和删除，Agents 页面做 discovery / join / guidance / profile / destructive management，但两边都调用同一个 API 语义和同一个 role enum。读侧继续维持 `openclaw.json + workspaces/<agentId>/agent-card.json` 合成的 `/watchdog/agents` 视图，不新增第三份 agent 配置真值。

**Tech Stack:** Node.js ESM, watchdog admin surface routes, dashboard modules, built-in `node:test`, filesystem workspace state under `~/.openclaw/workspaces`.

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `extensions/watchdog/lib/agent/agent-metadata.js` | Modify | 真正强校验 canonical role enum，收紧 `isSupportedAgentRole()` |
| `extensions/watchdog/dashboard-agent-role-input.js` | Modify | 让前端 role 输入与 canonical enum 同源 |
| `extensions/watchdog/dashboard-ux.js` | Modify | 主页面 quick create / delete / hard delete 入口 |
| `extensions/watchdog/dashboard-agents.js` | Modify | Agents 页面增加 hard delete，并复用统一确认语义 |
| `extensions/watchdog/lib/agent/agent-admin-agent-operations.js` | Modify | 新增 `hardDeleteAgentDefinition()`，复用 delete 清理路径并删除 workspace |
| `extensions/watchdog/lib/admin/admin-surface-operations.js` | Modify | 注册 `agents.hard_delete` 执行入口 |
| `extensions/watchdog/lib/admin/admin-surface-catalog.js` | Modify | 暴露 `/watchdog/agents/hard-delete` surface 元数据 |
| `extensions/watchdog/routes/api.js` | Modify | 注册 `POST /watchdog/agents/hard-delete` |
| `extensions/watchdog/tests/dashboard-agent-role-input.test.js` | Modify | 锁死前端 role 输入必须围绕 canonical enum |
| `extensions/watchdog/tests/admin-surface-canonical-api.test.js` | Modify | 锁死新 canonical hard-delete 路由 |
| `extensions/watchdog/tests/agent-delete-topology-cleanup.test.js` | Modify | 验证 delete 保留 workspace，hard delete 删除 workspace |
| `extensions/watchdog/tests/agent-role-genericity.test.js` or new `extensions/watchdog/tests/agent-role-validation.test.js` | Create/Modify | 验证 backend role 强校验 |

---

### Task 1: Freeze Canonical Role and Delete Semantics with Failing Tests

**Files:**
- Modify: `extensions/watchdog/tests/dashboard-agent-role-input.test.js`
- Modify: `extensions/watchdog/tests/admin-surface-canonical-api.test.js`
- Modify: `extensions/watchdog/tests/agent-delete-topology-cleanup.test.js`
- Create or Modify: `extensions/watchdog/tests/agent-role-validation.test.js`

- [ ] **Step 1: Add failing backend role-validation tests**

```javascript
import test from "node:test";
import assert from "node:assert/strict";

import {
  createAgentDefinition,
  changeAgentRole,
} from "../lib/agent/agent-admin-agent-operations.js";

test("createAgentDefinition rejects unsupported role strings", async () => {
  await assert.rejects(
    () => createAgentDefinition({
      id: `role-invalid-${Date.now()}`,
      role: "federated_reviewer",
      model: "ark-anthropic/deepseek-v3.2",
      logger: { info() {}, warn() {}, error() {} },
    }),
    /unsupported role/i,
  );
});

test("changeAgentRole rejects unsupported role strings", async () => {
  await assert.rejects(
    () => changeAgentRole({
      agentId: "planner",
      role: "meta_planner",
      logger: { info() {}, warn() {}, error() {} },
    }),
    /unsupported role/i,
  );
});
```

- [ ] **Step 2: Turn the role-input test from “custom slugs allowed” into canonical-enum-only UI**

```javascript
test("normalizeAgentRoleDraft falls back to default role for unsupported custom slugs", () => {
  assert.equal(normalizeAgentRoleDraft("federated_reviewer"), DEFAULT_AGENT_ROLE);
});

test("renderAgentRoleInput renders canonical role suggestions only", () => {
  const markup = renderAgentRoleInput({
    agentId: "agent-custom",
    value: "reviewer",
    compact: true,
  });

  assert.match(markup, /value="reviewer"/);
  assert.doesNotMatch(markup, /federated_reviewer/);
});
```

- [ ] **Step 3: Add canonical hard-delete route test**

```javascript
test("agents.hard-delete route requires canonical agentId", async () => {
  const routes = buildRegisteredRoutes();
  const handler = routes.get("/watchdog/agents/hard-delete");
  assert.equal(typeof handler, "function");

  const req = buildRequest("/watchdog/agents/hard-delete", {
    id: "legacy-agent-id",
    explicitConfirm: true,
  });
  const res = buildResponse();

  await handler(req, res);
  const response = res.snapshot();

  assert.equal(response.status, 400);
  assert.match(response.json?.error || "", /missing agentId/);
});
```

- [ ] **Step 4: Expand delete cleanup test into delete-vs-hard-delete semantics**

```javascript
test("deleteAgentDefinition keeps workspace files on disk", async () => {
  // Arrange: create temp agent and write sentinel file into workspace
  // Act: deleteAgentDefinition(...)
  // Assert: sentinel file still exists, config entry removed
});

test("hardDeleteAgentDefinition removes workspace files from disk", async () => {
  // Arrange: create temp agent and write sentinel file into workspace
  // Act: hardDeleteAgentDefinition(...)
  // Assert: workspace directory no longer exists, config entry removed
});
```

- [ ] **Step 5: Run tests to verify RED**

Run:

```bash
cd /Users/hakens/.openclaw/extensions/watchdog
node --test tests/dashboard-agent-role-input.test.js tests/admin-surface-canonical-api.test.js tests/agent-delete-topology-cleanup.test.js tests/agent-role-validation.test.js
```

Expected:
- FAIL because backend still accepts arbitrary non-empty roles
- FAIL because `/watchdog/agents/hard-delete` route does not exist
- FAIL because hard delete operation does not exist
- FAIL because frontend role input still preserves custom role slugs

- [ ] **Step 6: Commit the red baseline**

```bash
cd /Users/hakens/.openclaw
git add extensions/watchdog/tests/dashboard-agent-role-input.test.js extensions/watchdog/tests/admin-surface-canonical-api.test.js extensions/watchdog/tests/agent-delete-topology-cleanup.test.js extensions/watchdog/tests/agent-role-validation.test.js
git commit -m "test(agent-management): freeze canonical role and hard delete semantics"
```

---

### Task 2: Implement Canonical Role Enforcement

**Files:**
- Modify: `extensions/watchdog/lib/agent/agent-metadata.js`
- Modify: `extensions/watchdog/dashboard-agent-role-input.js`

- [ ] **Step 1: Make backend role validation actually use the enum**

```javascript
// extensions/watchdog/lib/agent/agent-metadata.js
export function isSupportedAgentRole(role) {
  const normalized = typeof role === "string" ? role.trim().toLowerCase() : "";
  return SUPPORTED_AGENT_ROLES.has(normalized);
}

export function isSystemActionEnabledRole(role) {
  const normalized = typeof role === "string" ? role.trim().toLowerCase() : "";
  return SYSTEM_ACTION_ENABLED_ROLES.has(normalized);
}
```

- [ ] **Step 2: Make the dashboard role input normalize unsupported slugs back to the canonical default**

```javascript
// extensions/watchdog/dashboard-agent-role-input.js
export const ROLE_SUGGESTIONS = Object.freeze([
  "agent",
  "bridge",
  "planner",
  "executor",
  "researcher",
  "reviewer",
]);

export function normalizeAgentRoleDraft(value, fallback = DEFAULT_AGENT_ROLE) {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized === "--") return fallback;
  return ROLE_SUGGESTIONS.includes(normalized) ? normalized : fallback;
}
```

- [ ] **Step 3: Run targeted tests to verify GREEN**

Run:

```bash
cd /Users/hakens/.openclaw/extensions/watchdog
node --test tests/dashboard-agent-role-input.test.js tests/agent-role-validation.test.js
```

Expected:
- PASS

- [ ] **Step 4: Commit**

```bash
cd /Users/hakens/.openclaw
git add extensions/watchdog/lib/agent/agent-metadata.js extensions/watchdog/dashboard-agent-role-input.js extensions/watchdog/tests/dashboard-agent-role-input.test.js extensions/watchdog/tests/agent-role-validation.test.js
git commit -m "fix(agent-management): enforce canonical role enum"
```

---

### Task 3: Add Canonical Hard Delete Backend Operation

**Files:**
- Modify: `extensions/watchdog/lib/agent/agent-admin-agent-operations.js`
- Modify: `extensions/watchdog/lib/admin/admin-surface-operations.js`
- Modify: `extensions/watchdog/lib/admin/admin-surface-catalog.js`
- Modify: `extensions/watchdog/routes/api.js`
- Modify: `extensions/watchdog/tests/admin-surface-canonical-api.test.js`
- Modify: `extensions/watchdog/tests/agent-delete-topology-cleanup.test.js`

- [ ] **Step 1: Add the destructive operation in agent-admin core**

```javascript
// extensions/watchdog/lib/agent/agent-admin-agent-operations.js
export async function hardDeleteAgentDefinition({
  agentId,
  logger = null,
  onAlert = null,
}) {
  return runAgentAdminWrite(async () => {
    const normalizedAgentId = normalizeString(agentId);
    if (!normalizedAgentId) throw new Error("missing agentId");
    if (isProtectedAgentId(normalizedAgentId)) {
      throw new Error(`cannot delete protected agent: ${normalizedAgentId}`);
    }

    const config = await loadConfig();
    const idx = config.agents.list.findIndex((item) => item?.id === normalizedAgentId);
    if (idx === -1) throw new Error(`agent not found: ${normalizedAgentId}`);

    config.agents.list.splice(idx, 1);
    await saveConfig(config);
    deleteAgentCard(normalizedAgentId);
    const remainingAgentIds = config.agents.list.map((item) => normalizeString(item?.id)).filter(Boolean);
    const topologyCleanup = await pruneTopologyArtifactsForKnownAgents(remainingAgentIds);
    await syncAllRuntimeWorkspaceGuidance(config, logger);

    const workspaceDir = agentWorkspace(normalizedAgentId);
    let workspaceDeleted = false;
    await rm(workspaceDir, { recursive: true, force: true }).then(() => {
      workspaceDeleted = true;
    });

    onAlert?.({ type: "agent_hard_deleted", agentId: normalizedAgentId, ts: Date.now() });
    return { ok: true, id: normalizedAgentId, hardDeleted: true, workspaceDeleted, topologyCleanup };
  });
}
```

- [ ] **Step 2: Register the new admin surface and route**

```javascript
// extensions/watchdog/lib/admin/admin-surface-operations.js
"agents.hard_delete": createAgentAdminOperation(hardDeleteAgentDefinition, (payload) => ({
  agentId: payload.agentId,
})),
```

```javascript
// extensions/watchdog/routes/api.js
registerAdminSurfacePostRoute("/watchdog/agents/hard-delete", "agents.hard_delete", {
  requireExplicitConfirm: true,
});
```

- [ ] **Step 3: Add catalog metadata**

```javascript
{
  id: "agents.hard_delete",
  stage: "apply",
  risk: "destructive",
  method: "POST",
  path: "/watchdog/agents/hard-delete",
  operatorPhase: "O2",
  confirmation: "explicit",
  status: "active",
  summary: "从系统中移除 agent，并删除本地 workspace 与画像/引导文件。",
}
```

- [ ] **Step 4: Make the delete semantics tests pass**

Run:

```bash
cd /Users/hakens/.openclaw/extensions/watchdog
node --test tests/admin-surface-canonical-api.test.js tests/agent-delete-topology-cleanup.test.js
```

Expected:
- PASS

- [ ] **Step 5: Commit**

```bash
cd /Users/hakens/.openclaw
git add extensions/watchdog/lib/agent/agent-admin-agent-operations.js extensions/watchdog/lib/admin/admin-surface-operations.js extensions/watchdog/lib/admin/admin-surface-catalog.js extensions/watchdog/routes/api.js extensions/watchdog/tests/admin-surface-canonical-api.test.js extensions/watchdog/tests/agent-delete-topology-cleanup.test.js
git commit -m "feat(agent-management): add canonical hard delete operation"
```

---

### Task 4: Unify Main-Page and Agents-Page Destructive UX

**Files:**
- Modify: `extensions/watchdog/dashboard-ux.js`
- Modify: `extensions/watchdog/dashboard-agents.js`

- [ ] **Step 1: Add shared confirmation wording in the main page**

```javascript
function buildHardDeleteWarning(agentId) {
  return `HARD DELETE \"${agentId}\"?\n\nThis will remove the local workspace and delete agent-card.json, SOUL.md, HEARTBEAT.md, managed guidance, inbox, outbox, and output.\n\nThis cannot be undone.`;
}
```

- [ ] **Step 2: Replace the single destructive action with DELETE + HARD DELETE**

```javascript
items.push(
  { label: "DELETE", danger: true, action: () => deleteAgent(agentId) },
  { label: "HARD DELETE", danger: true, action: () => hardDeleteAgent(agentId) },
);
```

- [ ] **Step 3: Add `hardDeleteAgent()` to the main page**

```javascript
async function hardDeleteAgent(agentId) {
  if (!confirm(buildHardDeleteWarning(agentId))) return;
  const token = new URLSearchParams(window.location.search).get("token") || "";
  const r = await fetch(`/watchdog/agents/hard-delete?token=${encodeURIComponent(token)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agentId, explicitConfirm: true }),
  });
  // on success: toast, clear savedPositions[agentId], loadAgentMeta()
}
```

- [ ] **Step 4: Add `Hard Delete` to the Agents page with the same warning text**

```javascript
const confirmed = window.confirm(
  `确认彻底删除 ${agentId}？\n\n这会删除本地 workspace，以及 agent-card.json、SOUL.md、HEARTBEAT.md、引导文件、inbox/outbox/output。\n\n此操作不可恢复。`,
);
```

- [ ] **Step 5: Ensure both UIs refresh from `/watchdog/agents` after success**

```javascript
await loadDiscovery();
loadAgentMeta();
```

- [ ] **Step 6: Smoke-test the frontend modules through existing unit coverage**

Run:

```bash
cd /Users/hakens/.openclaw/extensions/watchdog
node --test tests/dashboard-agent-role-input.test.js tests/admin-surface-canonical-api.test.js tests/agent-delete-topology-cleanup.test.js tests/agent-role-validation.test.js
```

Expected:
- PASS

- [ ] **Step 7: Commit**

```bash
cd /Users/hakens/.openclaw
git add extensions/watchdog/dashboard-ux.js extensions/watchdog/dashboard-agents.js
git commit -m "feat(agent-management): unify quick delete and hard delete surfaces"
```

---

### Task 5: Final Verification

**Files:**
- Verify only

- [ ] **Step 1: Run the focused regression suite**

Run:

```bash
cd /Users/hakens/.openclaw/extensions/watchdog
node --test tests/dashboard-agent-role-input.test.js tests/admin-surface-canonical-api.test.js tests/agent-delete-topology-cleanup.test.js tests/agent-role-validation.test.js
```

Expected:
- all PASS

- [ ] **Step 2: Run a broader dashboard/admin regression**

Run:

```bash
cd /Users/hakens/.openclaw/extensions/watchdog
node --test tests/dashboard-stage-visibility.test.js tests/work-item-surface-semantics.test.js tests/runtime-tracking-work-item-semantics.test.js
```

Expected:
- all PASS
- the existing `Invalid URL` noise from `dashboard-graph.js` may still appear in node test context, but exit code must be `0`

- [ ] **Step 3: Restart gateway so the frontend picks up new JS**

Run:

```bash
pkill -f 'openclaw-gateway' || true
cd /Users/hakens/.openclaw
nohup openclaw gateway run > /tmp/openclaw-gateway.log 2>&1 &
```

Expected:
- gateway listens on `localhost:18789`

