import { buildDispatchRuntimeSnapshot } from "../routing/dispatch/dispatch-runtime-state.js";
import { snapshotTrackingSessions } from "../store/tracker-store.js";
import { getTaskHistoryCount } from "../store/task-history-store.js";
import { getDispatchChainSize } from "../store/contract-flow-store.js";

export function inspectCliRuntimeState() {
  return {
    dispatchRuntime: buildDispatchRuntimeSnapshot(),
    trackingSessions: snapshotTrackingSessions(),
    historyCount: getTaskHistoryCount(),
    dispatchChainSize: getDispatchChainSize(),
  };
}
