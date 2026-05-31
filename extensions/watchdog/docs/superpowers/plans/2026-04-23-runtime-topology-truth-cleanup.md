# Runtime Topology Truth Cleanup Historical Note

This note records the completed April 2026 cleanup that moved ordinary runtime ingress back to graph-owned routing.

Outcome:
- First-hop dispatch resolves from the runtime graph owner.
- Ordinary runtime paths follow graph topology.
- System-action delivery remains a narrow runtime-owned return channel.
- Retired ingress routing metadata is treated as historical snapshot residue.

Current runtime entry points:
- `lib/ingress/dispatch-entry.js`
- `lib/ingress/dispatch-execution-contract-entry.js`
- `lib/routing/dispatch-graph-policy.js`
- `lib/routing/dispatch-transport.js`

Current verification entry points:
- `tests/dispatch-graph-policy.test.js`
- `tests/agent-end-graph-route-ownership.test.js`
- `tests/before-tool-call-path-guard.test.js`
- `tests/task-stage-runtime.test.js`
