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

  // Loop runtime
  LOOP_STARTED: "loop_started",
  LOOP_ADVANCED: "loop_advanced",
  LOOP_INTERRUPTED: "loop_interrupted",
  LOOP_RESUMED: "loop_resumed",
  LOOP_CONCLUDED: "loop_concluded",

  // Contract lifecycle
  TASK_AWAITING_INPUT: "task_awaiting_input",
  CONTRACT_SEMANTIC_FAILURE: "contract_semantic_failure",
  CONTRACT_STAGE_PLAN_UPDATED: "contract_stage_plan_updated",

  // Automation
  AUTOMATION_UPDATED: "automation_updated",
  AUTOMATION_ROUND_STARTED: "automation_round_started",
  AUTOMATION_ROUND_CONCLUDED: "automation_round_concluded",

  // Schedule
  SCHEDULE_TRIGGER: "schedule_trigger",
  SCHEDULE_UPDATED: "schedule_updated",

  // Agent
  AGENT_JOIN_UPDATED: "agent_join_updated",

  // System
  SYSTEM_RESET: "system_reset",
  WORKSPACE_MIGRATION_APPLIED: "workspace_migration_applied",
  LOOP_WARNING: "loop_warning",
  LOOP_DETECTED: "loop_detected",

  // Errors
  ERROR: "error",
  RUNTIME_WAKE_FAILED: "runtime_wake_failed",
  SYSTEM_ACTION_DELIVERY_FAILED: "system_action_delivery_failed",
  RUNTIME_AGENT_END_FAILED: "runtime_agent_end_failed",
  RUNTIME_FINALIZE_FAILED: "runtime_finalize_failed",
  RUNTIME_TRANSPORT_CLEANUP_FAILED: "runtime_transport_cleanup_failed",
  RUNTIME_CRASH_RECOVERY_FAILED: "runtime_crash_recovery_failed",
  RUNTIME_CONTRACT_READ_FAILED: "runtime_contract_read_failed",

  // QQ
  QQ_NOTIFY: "qq_notify",

  // Direct session
  DIRECT_SESSION: "direct_session",

  // Graph
  GRAPH_UPDATED: "graph_updated",
  GRAPH_COLLABORATION_BLOCKED: "graph_collaboration_blocked",

  // System actions
  AGENT_TASK_ASSIGNED: "agent_task_assigned",
  CODE_REVIEW_REQUESTED: "code_review_requested",

  // Bridge returns
  SYSTEM_ACTION_CONTRACT_RESULT_DELIVERED: "system_action_contract_result_delivered",
  SYSTEM_ACTION_ASSIGN_TASK_RESULT_DELIVERED: "system_action_assign_task_result_delivered",
  SYSTEM_ACTION_REVIEW_VERDICT_DELIVERED: "system_action_review_verdict_delivered",

  // Test runs
  TEST_RUN_CLEANING: "test_run_cleaning",
  TEST_CASE_STARTED: "test_case_started",
  TEST_CASE_FINISHED: "test_case_finished",
  TEST_RUN_STARTED: "test_run_started",
  TEST_RUN_FINISHED: "test_run_finished",
  TEST_RUN_FAILED: "test_run_failed",
});
