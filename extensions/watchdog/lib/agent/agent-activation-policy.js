export function canAutoWakeForTaskRuntime(actorPolicy) {
  return actorPolicy?.registered === true
    && actorPolicy?.plane === "runtime"
    && actorPolicy?.autoWakeEligible === true;
}
