---
name: prompt-craft
description: Use when writing or reviewing OpenClaw prompts, SOUL, managed guidance, wake text, operator prompts, skills, or agent-facing task instructions.
metadata: {"clawdbot":{"emoji":"✏️"}}
---

# OpenClaw Prompt Standard

OpenClaw prompts are minimal useful prompt surfaces. They describe the next useful action, the local role boundary, and the expected output. Runtime truth stays in stores, envelopes, policies, admin surfaces, and CLI surfaces.

## Core Standard

- Write the smallest prompt that lets the agent complete the current turn.
- Use positive task language: action, input, output, completion condition.
- Keep role posture in `SOUL.md`; keep reusable method in skills; keep protocol truth in runtime-owned objects.
- Collaboration goes through tool calls. Teach `[ACTION]` marker syntax only on the fallback page; a main prompt that carries the tools points to that page.
- Treat prompt-only choreography as a platform capability gap. Add runtime truth or a formal surface instead of more prose.
- Prefer progressive reading: point to the next relevant file or skill, then let the agent load it when needed.

## Prompt Shape

```text
Role: one sentence.
Context: only the current inputs the agent needs.
Task: concrete action for this turn.
Output: path, structure, or final message shape.
Completion: when to stop.
```

## OpenClaw Placement

- `SOUL.md`: identity, role posture, local workflow, stop condition.
- `HEARTBEAT.md`: liveness and wake posture.
- Platform docs: stable navigation and managed protocol overview.
- Skills: reusable methods that are read on demand.
- Runtime/CLI/operator/automation: enforcement, evidence, routing, topology, queues, budgets, and decisions.

## Formal Protocol Exposure

Tool calls are the primary agent-to-runtime command surface. `[ACTION]` markers are the
**fallback** for when tools are unavailable — the syntax lives in `COLLABORATION-FALLBACK.md`
and the main prompt carries only a pointer to it. Measured: an agent holding the tools falls
back to writing markers whenever both surfaces are taught side by side, because the marker
tutorial competes for attention with the tool schema.

JSON is appropriate when a formal runtime parser consumes structured fields, such as operator
plan output.

Every protocol phrase in a prompt should map to a runtime consumer. If no consumer exists, move the requirement to a platform object or delete the phrase.

## Review Checklist

- The prompt fits the current turn.
- Each sentence changes agent behavior for the task.
- Topology, queue state, wake semantics, delivery, budgets, and safety gates come from runtime truth.
- The prompt has one clear output target.
- The agent can succeed by following local instructions and formal surfaces.
