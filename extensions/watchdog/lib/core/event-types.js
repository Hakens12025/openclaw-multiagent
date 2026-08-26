// lib/event-types.js — Centralized SSE broadcast event type constants
//
// All broadcast("alert", { type: "..." }) calls should use these constants
// instead of raw strings to prevent typos and enable refactoring.

export const EVENT_TYPE = Object.freeze({
  // Dispatch/routing
  INBOX_DISPATCH: "inbox_dispatch",
  GRAPH_QUEUE: "graph_queue",
  DISPATCH_RUNTIME_STATE: "dispatch_runtime_state",

  // Delivery
  DELIVERY_CREATED: "delivery_created",
  DELIVERY_NOTIFIED: "delivery_notified",
  DELIVERY_SKIPPED: "delivery_skipped",
  DELIVERY_WRITE_FAILED: "delivery_write_failed",
  DELIVERY_NOTIFY_FAILED: "delivery_notify_failed",
  DELIVERY_TARGET_NOTIFY: "delivery_target_notify",

  // Test
  TEST_DELIVERY_RECORDED: "test_delivery_recorded",
  TEST_SINK_NOTIFIED: "test_sink_notified",
  // 测试收尾把控制态真值(agent-graph.json)恢复到测试前快照,且检出测试窗口内
  // 有人改过该文件(手改边会被回滚)时发此告警——恢复不再无声(2026-08-26 用户裁决 b)。
  TEST_CONTROL_STATE_RESTORED: "test_control_state_restored",

  // Contract lifecycle
  CONTRACT_SEMANTIC_FAILURE: "contract_semantic_failure",
  CONTRACT_STAGE_PLAN_UPDATED: "contract_stage_plan_updated",

  // Automation
  AUTOMATION_UPDATED: "automation_updated",
  AUTOMATION_ROUND_STARTED: "automation_round_started",
  AUTOMATION_ROUND_CONCLUDED: "automation_round_concluded",
  SKILL_PRECIPITATED: "skill_precipitated",

  // Schedule
  SCHEDULE_TRIGGER: "schedule_trigger",
  SCHEDULE_UPDATED: "schedule_updated",

  // Agent
  AGENT_JOIN_UPDATED: "agent_join_updated",

  // System
  SYSTEM_RESET: "system_reset",
  // 执行硬停的告警事件(重复工具调用逼近阈值)。2026-08-19 由 LOOP_WARNING 改名:
  // 它与图回路零关系,回路机制已退役,loop 一词不再承担任何功能。
  // 同批删除的 LOOP_DETECTED 是生产侧死常量(真发射走裸字符串,已随硬停归因修复收口)。
  EXECUTION_HARD_STOP_WARNING: "execution_hard_stop_warning",

  // Errors
  ERROR: "error",
  RUNTIME_WAKE_FAILED: "runtime_wake_failed",
  SYSTEM_ACTION_DELIVERY_FAILED: "system_action_delivery_failed",
  DELIVERY_PUMP_EXHAUSTED: "delivery_pump_exhausted",
  DELIVERY_PUMP_COMPLETED: "delivery_pump_completed",
  DELIVERY_TICKET_WRITE_FAILED: "delivery_ticket_write_failed",
  RUNTIME_AGENT_END_FAILED: "runtime_agent_end_failed",
  RUNTIME_FINALIZE_FAILED: "runtime_finalize_failed",
  RUNTIME_TRANSPORT_CLEANUP_FAILED: "runtime_transport_cleanup_failed",
  RUNTIME_CRASH_RECOVERY_FAILED: "runtime_crash_recovery_failed",
  RUNTIME_CONTRACT_READ_FAILED: "runtime_contract_read_failed",

  // QQ
  QQ_NOTIFY: "qq_notify",

  // Direct intake
  DIRECT_INTAKE_BLOCKED: "direct_intake_blocked",

  // Graph
  GRAPH_UPDATED: "graph_updated",

  // System actions
  AGENT_TASK_ASSIGNED: "agent_task_assigned",

  // Bridge returns
  SYSTEM_ACTION_RUNTIME_RESULT_DELIVERED: "system_action_runtime_result_delivered",
  SYSTEM_ACTION_ASSIGN_TASK_RESULT_DELIVERED: "system_action_assign_task_result_delivered",
  SYSTEM_ACTION_ROLE_POLICY_REJECTED: "system_action_role_policy_rejected",

  // Test runs
  TEST_RUN_CLEANING: "test_run_cleaning",
  TEST_CASE_STARTED: "test_case_started",
  TEST_CASE_FINISHED: "test_case_finished",
  TEST_RUN_STARTED: "test_run_started",
  TEST_RUN_FINISHED: "test_run_finished",
  TEST_RUN_FAILED: "test_run_failed",
});
