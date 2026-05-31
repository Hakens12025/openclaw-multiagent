function normalizeString(value) {
  return typeof value === "string" && value.trim()
    ? value.trim()
    : null;
}

function normalizeAmplifiers(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return [...new Set(value.map((entry) => normalizeString(entry)).filter(Boolean))];
}

function buildVerdict({
  rootFault = null,
  firstFaultCode = null,
  amplifiers = [],
  terminationMode = "continue",
} = {}) {
  return {
    rootFault: normalizeString(rootFault),
    firstFaultCode: normalizeString(firstFaultCode),
    amplifiers: normalizeAmplifiers(amplifiers),
    terminationMode,
  };
}

function hasNoFormalProgress(input = {}) {
  return input?.progress?.hasFormalProgress === false;
}

export function evaluateRuntimeFault(input = {}) {
  const priorIncident = input?.priorIncident || null;
  const priorAmplifiers = normalizeAmplifiers(priorIncident?.amplifiers);
  const actorPlane = normalizeString(input?.actor?.plane);
  const wrongActorActivation = input?.wrongActorActivation
    || (actorPlane === "control_plane" ? input.actor : null);

  if (wrongActorActivation) {
    if (priorIncident?.rootFault && priorIncident.rootFault !== "system_fault") {
      return buildVerdict({
        rootFault: "mixed_fault",
        firstFaultCode: priorIncident.firstFaultCode || "wrong_actor_activation",
        amplifiers: [...priorAmplifiers, "wrong_actor_activation"],
        terminationMode: "terminate_with_diagnosis",
      });
    }
    return buildVerdict({
      rootFault: "system_fault",
      firstFaultCode: priorIncident?.firstFaultCode || "wrong_actor_activation",
      amplifiers: priorAmplifiers,
      terminationMode: "terminate_with_diagnosis",
    });
  }

  if (normalizeString(input?.hardStopReason) === "max_tool_calls" && hasNoFormalProgress(input)) {
    return buildVerdict({
      rootFault: "llm_fault",
      firstFaultCode: priorIncident?.firstFaultCode || "max_tool_calls",
      amplifiers: priorAmplifiers,
      terminationMode: "terminate_with_diagnosis",
    });
  }

  if (Number(input?.toolLoop?.sameToolSameInputCount || 0) >= 3 && hasNoFormalProgress(input)) {
    return buildVerdict({
      rootFault: "llm_fault",
      firstFaultCode: priorIncident?.firstFaultCode || "identical_tool_loop",
      amplifiers: priorAmplifiers,
      terminationMode: "terminate_with_diagnosis",
    });
  }

  return buildVerdict();
}
