import test from "node:test";
import assert from "node:assert/strict";

import { classifyRuntimeControlPayload } from "../lib/runtime-user-facing-output.js";

test("localized read failure text is classified as runtime control residue", () => {
  const payload = [
    "[error] 读取 `/Users/hakens/.openclaw/workspaces/worker2/inbox/contract.json` 失败，需要相对路径。",
    "",
    "请提供以下信息：",
    "1. 当前会话的 inbox 目录路径",
    "2. 当前会话的 contract.json 文件路径",
  ].join("\n");

  assert.equal(
    classifyRuntimeControlPayload(payload, { outputPath: "/tmp/contract-output.md" }),
    "tool_error_text",
  );
});
