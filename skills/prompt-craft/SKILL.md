---
name: prompt-craft
description: Use when writing or reviewing OpenClaw prompts, SOUL, managed guidance, wake text, operator prompts, skills, or agent-facing task instructions.
metadata: {"clawdbot":{"emoji":"✏️"}}
---

# OpenClaw Prompt Standard

OpenClaw prompts are minimal useful prompt surfaces. They describe the next useful action, the local role boundary, and the expected output. Runtime truth stays in stores, envelopes, policies, admin surfaces, harness evidence, and CLI surfaces.

## Core Standard

- Write the smallest prompt that lets the agent complete the current turn.
- Use positive task language: action, input, output, completion condition.
- Keep role posture in `SOUL.md`; keep reusable method in skills; keep protocol truth in runtime-owned objects.
- Expose `[ACTION]` and JSON only where the runtime consumes them as formal protocol.
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
- Runtime/harness/CLI/operator/automation: enforcement, evidence, routing, topology, queues, budgets, and decisions.

## Formal Protocol Exposure

`[ACTION]` is the concise agent-to-runtime command surface. Keep it visible for roles that can use it.

JSON is appropriate when a formal runtime parser consumes structured fields, such as complex `[ACTION]` payloads or operator plan output.

Every protocol phrase in a prompt should map to a runtime consumer. If no consumer exists, move the requirement to a platform object or delete the phrase.

## Review Checklist

- The prompt fits the current turn.
- Each sentence changes agent behavior for the task.
- Topology, queue state, wake semantics, delivery, budgets, and safety gates come from runtime truth.
- The prompt has one clear output target.
- The agent can succeed by following local instructions and formal surfaces.
