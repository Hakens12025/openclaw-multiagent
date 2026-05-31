// Prompt builders and review fixture preparation for direct-service probes

import { mkdir, writeFile } from "node:fs/promises";
import { OUTPUT_DIR } from "./infra.js";
import { join } from "node:path";

export const REVIEW_FIXTURE = join(OUTPUT_DIR, "REQ-direct-service-review-probe.js");

export function buildCreateTaskProbePrompt() {
  const actionMarker = "[ACTION] "
    + JSON.stringify({
      type: "create_task",
      params: {
        message: "回复 CHILD_OK 后结束。",
        source: "webui",
      },
    });
  return [
    "这是一个 system_action delivery 测试。",
    "先读取当前任务。",
    "将结果文件写成下面这一行 [ACTION] marker：",
    actionMarker,
    "收到子流程回送结果后，将结果文件更新为 PARENT_RECEIVED。",
  ].join("\n");
}

export function buildReviewProbePrompt({ artifactPath }) {
  const actionMarker = "[ACTION] "
    + JSON.stringify({
    type: "request_review",
    params: {
      instruction: "请审查这个实现；若存在未定义变量或明显运行错误，请直接给出 reject，并简要指出问题。",
      artifactManifest: [
        { path: artifactPath, label: "review_probe" },
      ],
    },
  });

  return [
    "这是一个 system_action delivery 测试。",
    "先读取当前任务。",
    "将结果文件写成下面这一行 [ACTION] marker：",
    actionMarker,
    "收到 reviewer verdict 后，将结果文件更新为 REVIEW_PARENT_RECEIVED。",
  ].join("\n");
}

export function buildAssignTaskProbePrompt({ delegateAgentId }) {
  const actionMarker = "[ACTION] "
    + JSON.stringify({
    type: "assign_task",
    params: {
      targetAgent: delegateAgentId,
      instruction: "把 CHILD_ASSIGNEE_OK 写入 output 指定路径后结束。",
      reason: "direct-service assign_task return probe",
    },
  });

  return [
    "这是一个 system_action delivery 测试。",
    "先读取当前任务。",
    "将结果文件写成下面这一行 [ACTION] marker：",
    actionMarker,
    "收到 delegated result 后，将结果文件更新为 ASSIGN_PARENT_RECEIVED。",
  ].join("\n");
}

export async function prepareReviewFixture() {
  await mkdir(OUTPUT_DIR, { recursive: true });
  await writeFile(REVIEW_FIXTURE, [
    "export function computeTotal(items) {",
    "  const subtotal = items.reduce((acc, item) => acc + item.price, 0);",
    "  return subtotal + taxRate;",
    "}",
    "",
    "console.log(computeTotal([{ price: 1 }, { price: 2 }]));",
  ].join("\n"), "utf8");
  return { artifactPath: REVIEW_FIXTURE };
}
