function compactRuntimeBits(fields) {
  return Object.entries(fields)
    .filter(([, value]) => value !== null && value !== undefined && value !== "")
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
}

function describeTerminalDeliveryHint(terminalDelivery) {
  if (!terminalDelivery || typeof terminalDelivery !== "object") return null;
  if (terminalDelivery.ok === true && !terminalDelivery.fallback) return null;

  const lane = terminalDelivery.lane || "terminal_delivery";
  if (terminalDelivery.error === "missing_reply_target" || terminalDelivery.stage === "resolve_reply_target") {
    return {
      lane,
      summary: "delivery skipped before persistence: missing_reply_target",
      detail: compactRuntimeBits({
        channel: terminalDelivery.channel || "delivery",
        stage: terminalDelivery.stage || "resolve_reply_target",
        persisted: terminalDelivery.persisted,
        notified: terminalDelivery.notified,
      }),
    };
  }

  if (terminalDelivery.stage === "write") {
    return {
      lane,
      summary: `delivery write failed${terminalDelivery.error ? `: ${terminalDelivery.error}` : ""}`,
      detail: compactRuntimeBits({
        channel: terminalDelivery.channel || "delivery",
        persisted: terminalDelivery.persisted,
        notified: terminalDelivery.notified,
      }),
    };
  }

  if (terminalDelivery.stage === "notify" && terminalDelivery.persisted === true && terminalDelivery.notified === false) {
    return {
      lane,
      summary: `delivery persisted but notify failed${terminalDelivery.error ? `: ${terminalDelivery.error}` : ""}`,
      detail: compactRuntimeBits({
        channel: terminalDelivery.channel || "delivery",
        deliveryId: terminalDelivery.deliveryId || null,
        targetAgent: terminalDelivery.targetAgent || null,
      }),
    };
  }

  if (terminalDelivery.fallback) {
    const fallback = terminalDelivery.fallback;
    return {
      lane,
      summary: `primary terminal delivery failed${terminalDelivery.primaryError ? `: ${terminalDelivery.primaryError}` : ""}; fallback ${fallback.ok ? "succeeded" : "failed"}`,
      detail: compactRuntimeBits({
        primaryChannel: terminalDelivery.primaryChannel || null,
        fallbackChannel: fallback.channel || null,
        fallbackStage: fallback.stage || null,
        fallbackError: fallback.error || null,
      }),
    };
  }

  if (terminalDelivery.ok === false) {
    return {
      lane,
      summary: `terminal delivery failed${terminalDelivery.error ? `: ${terminalDelivery.error}` : ""}`,
      detail: compactRuntimeBits({
        channel: terminalDelivery.channel || null,
        stage: terminalDelivery.stage || null,
        persisted: terminalDelivery.persisted,
        notified: terminalDelivery.notified,
      }),
    };
  }

  return null;
}

function findSystemActionDeliveryRuntimeHint(deliveryId, delivery) {
  if (!delivery || typeof delivery !== "object") return null;

  if (delivery.error) {
    return {
      lane: delivery.lane || deliveryId,
      summary: `system_action delivery failed${delivery.error ? `: ${delivery.error}` : ""}`,
      detail: compactRuntimeBits({
        deliveryId,
        targetAgent: delivery.targetAgent || null,
        contractId: delivery.contractId || null,
      }),
    };
  }

  if (delivery.wake && delivery.wake.ok === false) {
    return {
      lane: delivery.wake.lane || `${delivery.lane || deliveryId}.wake`,
      summary: `system_action delivery resume failed${delivery.wake.error ? `: ${delivery.wake.error}` : ""}`,
      detail: compactRuntimeBits({
        deliveryId,
        targetAgent: delivery.wake.targetAgent || delivery.targetAgent || null,
        mode: delivery.wake.mode || null,
        requested: delivery.wake.requested,
      }),
    };
  }

  if (delivery.nestedDelivery) {
    return findSystemActionDeliveryRuntimeHint(`${deliveryId}.nested`, delivery.nestedDelivery);
  }

  return null;
}

export function describeRuntimeHint(result, issue) {
  const runtime = result?.contractRuntime;
  if (!runtime || typeof runtime !== "object") return null;

  const diagnostics = runtime.runtimeDiagnostics || {};
  const completionHint = describeTerminalDeliveryHint(diagnostics.terminalDelivery);
  const systemWake = runtime.systemAction?.wake;
  const systemWakeHint = systemWake && systemWake.ok === false
    ? {
        lane: systemWake.lane || "system_action.wake",
        summary: `system_action wake failed${systemWake.error ? `: ${systemWake.error}` : ""}`,
        detail: compactRuntimeBits({
          targetAgent: systemWake.targetAgent || runtime.systemAction?.targetAgent || null,
          mode: systemWake.mode || null,
          requested: systemWake.requested,
        }),
      }
    : null;

  let deliveryHint = null;
  const systemActionDelivery = diagnostics.systemActionDelivery || {};
  for (const [deliveryId, delivery] of Object.entries(systemActionDelivery)) {
    deliveryHint = findSystemActionDeliveryRuntimeHint(deliveryId, delivery);
    if (deliveryHint) break;
  }

  if (issue?.errorCode === "E_DELIVERY_MISS" || issue?.errorCode === "E_CTRL_NOTIFY_FAIL") {
    return completionHint || systemWakeHint || deliveryHint;
  }

  return deliveryHint || systemWakeHint || completionHint;
}
