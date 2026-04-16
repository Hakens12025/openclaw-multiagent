# Compatibility Layer Removal Design

**Context**

OpenClaw now has a newer control-plane direction: `graph + ingress.normalize + conveyor.dispatch + lifecycle.commit + loop engine`. But several active code paths still preserve old truth models:

1. `test` agent legacy constants and source fallback
2. agent binding / identity / router legacy fallback and field mirroring
3. `start_pipeline` legacy payload normalization and contractor-to-worker fallback semantics
4. startup-time schema compat patching of installed OpenClaw bundles

These are no longer harmless history. They keep old truth alive in runtime behavior, startup behavior, and tests.

**Decision**

Remove compatibility in one direction only: current runtime truth stays valid, old truth stops being auto-accepted.

This round will:
- remove the `test` agent legacy identity truth from code
- stop mirroring binding back into legacy flat agent config fields
- stop inferring role/gateway/protected/specialized/router behavior from legacy ids or missing runtime truth
- stop accepting legacy `start_pipeline` aliases and context-derived fallback semantics
- stop patching installed OpenClaw bundles at startup for old schema acceptance

This round will not:
- remove ordinary transport reliability fallback such as hooks-to-heartbeat wake fallback
- rewrite operator fallback behavior, because that is not the same category of legacy protocol compatibility
- rewrite old memo files yet; they will be audited after code truth is cleaned

**Recommended Approach**

Approach A: Full cutover now. Recommended.
- Pros: one truth, lower confusion, tests become honest
- Cons: more failing tests to update in one pass

Approach B: soft deprecation first
- Pros: lower immediate blast radius
- Cons: preserves exactly the ambiguity we are trying to kill

Approach C: hide old paths behind warnings only
- Pros: easiest short-term
- Cons: does not change runtime truth and will regress again

Chosen: Approach A.

**Execution Order**

1. Write failing tests for each active compatibility seam.
2. Remove `test` legacy identity truth.
3. Remove binding/identity/router legacy fallback and legacy field mirroring.
4. Remove `start_pipeline` legacy normalization and contractor fallback semantics.
5. Remove startup schema compat patching.
6. Run targeted regression suites, then formal presets, and verify loop/platform paths still work.

**Verification**

Minimum verification for this round:
- targeted unit/runtime suites covering agent model, unified control plane, conveyor, loop validity, and contractor handoff semantics
- formal preset verification, including at least `single`, `multi`, `concurrent`, and `loop-platform`
- if `direct-service` formal preset still exists after cleanup, run it too and decide later whether the preset itself should survive as a naming artifact
