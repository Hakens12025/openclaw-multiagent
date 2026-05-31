export type DispatchMarkerFormat = "action_delegate";

export interface ParsedDispatchMarker {
  message: string;
  targetAgent: string | null;
  format: DispatchMarkerFormat;
}

function normalizeNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function tryParseJsonDelegate(body: string): ParsedDispatchMarker | null {
  if (!body.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(body);
    if (!parsed || typeof parsed !== "object") return null;
    const record = parsed as Record<string, unknown>;
    const message = normalizeNonEmptyString(record.message)
      || normalizeNonEmptyString(record.task)
      || normalizeNonEmptyString(record.prompt);
    const targetAgent = normalizeNonEmptyString(record.targetAgent)
      || normalizeNonEmptyString(record.target);
    if (!message) return null;
    return { message, targetAgent, format: "action_delegate" };
  } catch {
    return null;
  }
}

/**
 * Formal dispatch syntax (the only one now supported):
 *   [ACTION] delegate <agentId> — <instruction>
 * The separator between agentId and instruction accepts em-dash (—), en-dash
 * (–), or ascii hyphen (-), flanked by whitespace. JSON body form is also
 * accepted: `[ACTION] delegate {"targetAgent":"...","message":"..."}`.
 * Legacy `[DISPATCH]...[/DISPATCH]` has been retired.
 */
export function parseDispatchMarker(replyText: string): ParsedDispatchMarker | null {
  const actionMatch = replyText.match(/\[ACTION\]\s*delegate\s+([\s\S]+)$/m);
  if (!actionMatch) return null;
  const body = normalizeNonEmptyString(actionMatch[1]);
  if (!body) return null;
  const jsonForm = tryParseJsonDelegate(body);
  if (jsonForm) return jsonForm;
  const separated = body.match(/^(\S+)\s+[—–-]\s+([\s\S]+)$/);
  if (separated) {
    const targetAgent = normalizeNonEmptyString(separated[1]);
    const message = normalizeNonEmptyString(separated[2]);
    if (targetAgent && message) {
      return { message, targetAgent, format: "action_delegate" };
    }
  }
  return { message: body, targetAgent: null, format: "action_delegate" };
}
