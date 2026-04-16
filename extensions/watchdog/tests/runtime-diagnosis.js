function compactRuntimeBits(fields) {
  return Object.entries(fields)
    .filter(([, value]) => value !== null && value !== undefined && value !== "")
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
}

function describeCompletionEgressHint(egress) {
  if (!egress || typeof egress !== "object") return null;
  if (egress.ok === true && !egress.fallback) return null;

  const lane = egress.lane || "completion_egress";
  if (egress.error === "missing_reply_target" || egress.stage === "resolve_reply_target") {
    return {
      lane,
      summary: "delivery skipped before persistence: missing_reply_target",
      detail: compactRuntimeBits({
        channel: egress.channel || "delivery",
        stage: egress.stage || "resolve_reply_target",
        persisted: egress.persisted,
        notified: egress.notified,
      }),
    };
  }

  if (egress.stage === "write") {
    return {
      lane,
      summary: `delivery write failed${egress.error ? `: ${egress.error}` : ""}`,
      detail: compactRuntimeBits({
        channel: egress.channel || "delivery",
        persisted: egress.persisted,
        notified: egress.notified,
      }),
    };
  }

  if (egress.stage === "notify" && egress.persisted === true && egress.notified === false) {
    return {
      lane,
      summary: `delivery persisted but notify failed${egress.error ? `: ${egress.error}` : ""}`,
      detail: compactRuntimeBits({
        channel: egress.channel || "delivery",
        deliveryId: egress.deliveryId || null,
        targetAgent: egress.targetAgent || null,
      }),
    };
  }

  if (egress.fallback) {
    const fallback = egress.fallback;
    return {
      lane,
      summary: `primary completion egress failed${egress.primaryError ? `: ${egress.primaryError}` : ""}; fallback ${fallback.ok ? "succeeded" : "failed"}`,
      detail: compactRuntimeBits({
        primaryChannel: egress.primaryChannel || null,
        fallbackChannel: fallback.channel || null,
        fallbackStage: fallback.stage || null,
        fallbackError: fallback.error || null,
      }),
    };
  }

  if (egress.ok === false) {
    return {
      lane,
      summary: `completion egress failed${egress.error ? `: ${egress.error}` : ""}`,
      detail: compactRuntimeBits({
        channel: egress.channel || null,
        stage: egress.stage || null,
        persisted: egress.persisted,
        notified: egress.notified,
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
      summary: `system_action delivery wake failed${delivery.wake.error ? `: ${delivery.wake.error}` : ""}`,
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
  const completionHint = describeCompletionEgressHint(diagnostics.completionEgress);
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
