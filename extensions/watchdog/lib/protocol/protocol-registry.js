export const PROTOCOL_ID = Object.freeze({
  DISPATCH: Object.freeze({
    EXECUTION_CONTRACT: "dispatch:execution_contract",
    DIRECT_REQUEST: "dispatch:direct_request",
  }),
  SYSTEM_ACTION: Object.freeze({
    CREATE_TASK: "system_action:create_task",
    ASSIGN_TASK: "system_action:assign_task",
    WAKE_AGENT: "system_action:wake_agent",
  }),
  DELIVERY: Object.freeze({
    TERMINAL: "delivery:terminal",
    SYSTEM_ACTION_RUNTIME_RESULT: "delivery:system_action_runtime_result",
    SYSTEM_ACTION_ASSIGN_TASK_RESULT: "delivery:system_action_assign_task_result",
  }),
});

export const CARRIER_ID = Object.freeze({
  EXECUTION_CONTRACT: "carrier:execution_contract",
  DIRECT_REQUEST: "carrier:direct_request",
  DELIVERY_RECORD: "carrier:delivery_record",
  HEARTBEAT: "carrier:heartbeat",
});

export const FLOW_VISUAL_ID = Object.freeze({
  DISPATCH_GRAPH: "flow_visual:dispatch_graph",
  DISPATCH_DIRECT: "flow_visual:dispatch_direct",
  DELIVERY_TERMINAL: "flow_visual:delivery_terminal",
  DELIVERY_RETURN: "flow_visual:delivery_return",
});
