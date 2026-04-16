import { DELIVERY_WORKFLOWS } from "./routing/delivery-protocols.js";

export const SEMANTIC_WORKFLOWS = Object.freeze({
  DELIVERY_SYSTEM_ACTION: "delivery_system_action",
  DELIVERY_TERMINAL: "delivery_terminal",
  WORKFLOW_CONCLUSION_RETURN: "workflow_conclusion_return",
  WORKFLOW_CONCLUSION_RESUME: "workflow_conclusion_resume",
  WORKFLOW_CONCLUSION_TERMINAL: "workflow_conclusion_terminal",
});

export function inferSemanticWorkflow(value) {
  switch (value) {
    case DELIVERY_WORKFLOWS.SYSTEM_ACTION_CONTRACT_RESULT:
    case DELIVERY_WORKFLOWS.SYSTEM_ACTION_ASSIGN_TASK_RESULT:
    case DELIVERY_WORKFLOWS.SYSTEM_ACTION_REVIEW_VERDICT:
      return SEMANTIC_WORKFLOWS.DELIVERY_SYSTEM_ACTION;
    case DELIVERY_WORKFLOWS.TERMINAL:
      return SEMANTIC_WORKFLOWS.DELIVERY_TERMINAL;
    case "workflow_conclusion_return":
      return SEMANTIC_WORKFLOWS.WORKFLOW_CONCLUSION_RETURN;
    case "workflow_conclusion_resume":
      return SEMANTIC_WORKFLOWS.WORKFLOW_CONCLUSION_RESUME;
    case "workflow_conclusion_terminal":
    case "adapter_conclusion_terminal":
      return SEMANTIC_WORKFLOWS.WORKFLOW_CONCLUSION_TERMINAL;
    default:
      return null;
  }
}
