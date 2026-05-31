// Shared runtime token/endpoint state for formal-runtime
// Leaf module: no imports from other infra files to avoid circular deps.

export const PORT = 18789;
export const BASE = `http://localhost:${PORT}`;

// Mutable token object — mutated by loadConfig() in infra.js.
// All consumers that import this object share the same reference and see updates.
export const tokens = { gateway: "", hook: "" };
