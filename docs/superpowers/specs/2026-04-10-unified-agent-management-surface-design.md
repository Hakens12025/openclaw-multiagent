# Unified Agent Management Surface Design

**Date:** 2026-04-10
**Scope:** OpenClaw dashboard agent creation, join, profile mutation, deletion, hard deletion, and topology synchronization
**Status:** proposed
**Relation to prior work:** narrows the current dual-entry agent UI into one shared management semantics while preserving both the main topology quick actions and the dedicated Agents page.

## Problem

OpenClaw currently has two valid but partially divergent agent-management surfaces:

1. the main topology page in edit mode
2. the dedicated Agents page

Both can mutate agent state, but they do not represent one clearly unified management model.

Current pain points:

- the main page is the fastest place to create or remove an agent from the visible topology
- the Agents page is the richer place to discover, join, inspect, and repair agent assets
- delete today means "remove from system registration" but the UI does not expose a second destructive mode that deletes the local workspace
- role input visually suggests a finite role enum, while backend validation still accepts any non-empty string
- this creates a risk of shell and kernel diverging again

The user requirement is explicit:

- keep both entry points
- main page must remain convenient for quick topology editing
- Agents page must remain available for deeper system management
- role semantics must be truly unified
- delete and hard delete must be split
- hard delete must warn that local workspace files will be removed

## Decision

We will implement **one shared agent-management core**, exposed through **two preserved UI entry points**:

- **Main topology page**
  - fast, lightweight, topology-first quick actions
- **Agents page**
  - full management surface for discovery, join, guidance, profile inspection, and destructive operations

This is not "two systems with similar buttons".

It is:

- one canonical backend operation set
- one canonical role enum
- one canonical deletion semantics model
- two UI shells with different density and purpose

## Goals

- preserve main-page convenience for create/delete actions
- preserve Agents page as the complete management console
- unify create/join/delete/hard-delete semantics behind one backend truth
- introduce a real role enum contract enforced by the backend
- make hard delete explicitly and visibly destructive
- keep dashboard topology auto-refresh behavior after mutations
- keep `openclaw.json` plus workspace `agent-card.json` as the only agent truth sources

## Non-Goals

- redesigning the visual topology layout engine
- changing `/watchdog/agents` into a different data model
- deleting global reports, test artifacts, or unrelated files during hard delete
- inventing a third agent configuration source
- merging join semantics into create semantics

## Current Truth

Current backend truth is already mostly sound:

- system registration and binding truth live in `openclaw.json`
- workspace truth lives in `workspaces/<agentId>/`
- `agent-card.json` and managed guidance are workspace-local
- `/watchdog/agents` is a composed view over config plus workspace projection

This should remain unchanged.

The missing part is **surface unification**, not storage reinvention.

## User-Facing Model

### 1. Main Topology Page

The main topology page remains the quickest place to change the visible team.

It will keep:

- `Create Agent`
- `Delete`
- `Hard Delete`
- model switch

But it will remain intentionally lightweight:

- no discovery grid
- no guidance preview
- no local-workspace enrollment details
- no advanced profile editing

Meaning:

- the main page is for quick operational shaping of the active lineup
- the Agents page is for full lifecycle management

### 2. Agents Page

The Agents page remains the complete management surface.

It will own:

- discovery of local unmanaged workspaces
- join into system
- guidance preview and takeover
- role / card / profile editing
- `Delete`
- `Hard Delete`

The Agents page is therefore the canonical management console, while the main page is a fast shortcut layer.

## Canonical Operation Set

All UIs must call one shared backend semantics set:

- `agents.create`
- `agents.join`
- `agents.delete`
- `agents.hard_delete`
- existing profile mutation operations

No UI may implement private deletion or private role semantics.

## Delete Semantics

### `Delete`

`Delete` means:

- remove the agent from `openclaw.json`
- unregister runtime identity
- prune topology / loop references that become invalid
- clear UI layout cache for that agent

`Delete` does **not** mean:

- delete `workspaces/<agentId>/`
- delete `agent-card.json`
- delete guidance files
- delete inbox / outbox / output contents from disk

This is a "remove from system management" operation.

### `Hard Delete`

`Hard Delete` means:

- perform everything that `Delete` does
- then remove `workspaces/<agentId>/` recursively
- remove local workspace guidance and card files
- remove local inbox / outbox / output contents with the workspace
- remove saved node layout cache for that agent
- clear runtime state residues tied to that agent

`Hard Delete` does **not** mean:

- delete global test reports
- delete unrelated files
- rewrite or delete other agents' documents
- delete historical system logs outside the workspace

This is a true destructive local asset removal.

## Hard Delete Confirmation Contract

Both UIs must show an explicit destructive confirmation.

Required warning content:

- local workspace will be deleted
- `agent-card.json`, `SOUL.md`, `HEARTBEAT.md`, managed guidance, inbox, outbox, and output will be removed
- operation is not reversible

Recommended confirmation behavior:

- first confirm dialog explains scope
- second explicit keyword or checkbox is optional, not required for this phase

For this phase, one strong explicit confirmation dialog is enough.

## Role Contract

### Canonical Roles

The system role enum is:

- `bridge`
- `planner`
- `executor`
- `researcher`
- `reviewer`
- `agent`

### Enforcement

Backend validation must only accept the canonical enum.

This closes the current mismatch where the UI suggests a finite enum but backend validation accepts any non-empty string.

Normalization rules:

- trim input
- lowercase input
- reject unknown values with `400`
- do not silently persist unsupported roles

### Shared UI Source

The main page role selector and the Agents page role input must draw from the same exported role list.

This avoids drift such as:

- one UI offering only 4 roles
- another UI offering 6 roles
- backend accepting arbitrary strings

## Storage Model

Storage remains unchanged.

### Config Truth

- `~/.openclaw/openclaw.json`
  - registration
  - binding
  - workspace path
  - model ref
  - configured skills
  - policies

### Workspace Truth

- `~/.openclaw/workspaces/<agentId>/`
  - `agent-card.json`
  - `SOUL.md`
  - `HEARTBEAT.md`
  - managed guidance files
  - `inbox/`
  - `outbox/`
  - `output/`

### Read Side

`/watchdog/agents` remains a composed read model:

- config binding
- workspace card projection
- derived effective profile

No additional storage file should be added.

## Topology Synchronization

The topology page already rebuilds from `/watchdog/agents`.

That behavior should remain:

- create -> emit `agent_created` -> reload metadata -> rebuild topology
- delete -> emit `agent_deleted` -> reload metadata -> rebuild topology
- hard delete -> emit `agent_hard_deleted` -> reload metadata -> rebuild topology

Backend must continue pruning invalid graph and loop references when agents are removed.

## API Changes

### New Operation

Add:

- `POST /watchdog/agents/hard-delete`

Expected payload:

```json
{
  "agentId": "worker-e",
  "explicitConfirm": true
}
```

Expected result shape:

```json
{
  "ok": true,
  "id": "worker-e",
  "hardDeleted": true,
  "workspaceDeleted": true,
  "topologyCleanup": {
    "changed": true,
    "removedEdges": [],
    "removedLoops": [],
    "removedSessions": []
  }
}
```

### Existing Operations

Keep:

- `POST /watchdog/agents/create`
- `POST /watchdog/agents/join`
- `POST /watchdog/agents/delete`

But ensure both UI surfaces use the same semantics and confirmation boundaries.

## Implementation Shape

### Backend

Introduce a dedicated destructive operation next to `deleteAgentDefinition`:

- `hardDeleteAgentDefinition`

Responsibilities:

1. validate agent id
2. reject protected agents
3. remove agent from config
4. save config
5. delete runtime card cache
6. prune topology artifacts
7. remove workspace directory recursively
8. emit hard-delete lifecycle alert

### Frontend

#### Main Page

Keep existing quick-create and delete affordances, but:

- expand role list to canonical enum
- replace destructive delete menu with:
  - `DELETE`
  - `HARD DELETE`
- use shared confirmation wording

#### Agents Page

Add `Hard Delete` alongside existing `Delete`.

The Agents page remains the place where the operator can understand what is going to be destroyed.

## Error Handling

- protected agents cannot be deleted or hard deleted
- hard delete of a missing workspace should still succeed if system deregistration succeeds, but result must report that workspace was already absent
- invalid role input must fail before config write
- UI must surface backend error text directly

## Tests

Required regression coverage:

1. create rejects unsupported roles
2. role mutation rejects unsupported roles
3. delete removes config entry but leaves workspace intact
4. hard delete removes config entry and workspace
5. hard delete prunes graph / loop residues same as delete
6. main page and Agents page both call canonical routes
7. protected agents remain undeletable

## Risks

### 1. Partial UI Drift

If the main page and Agents page still keep separate role lists or separate confirmation text, this cleanup will fail in spirit.

### 2. Destructive Scope Expansion

Hard delete must stay scoped to the agent workspace and direct runtime residues only.

If it starts deleting shared assets, it becomes unsafe.

### 3. Event Naming Drift

If hard delete invents a private frontend-only meaning instead of following the canonical mutation event model, we will recreate shell/kernel divergence.

## Recommendation

Implement this as a shared backend mutation core plus two preserved UI shells.

Do not remove either shell.

Do not add new storage truth.

Do not leave role validation loose.

Do not make hard delete ambiguous.
