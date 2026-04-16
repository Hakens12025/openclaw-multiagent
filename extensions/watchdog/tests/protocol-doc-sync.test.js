import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

async function readProjectFile(...parts) {
  return readFile(join(process.cwd(), ...parts), "utf8");
}

test("active protocol docs reference canonical dispatch and delivery truth", async () => {
  const [threeLayer, delivery, bridgeDecision, status] = await Promise.all([
    readProjectFile("..", "..", "wiki", "concepts", "three-layer-protocol.md"),
    readProjectFile("..", "..", "wiki", "concepts", "delivery.md"),
    readProjectFile("..", "..", "wiki", "decisions", "runtime-bridge-into-delivery.md"),
    readProjectFile("..", "..", "wiki", "status.md"),
  ]);

  assert.match(threeLayer, /dispatch-entry\.js/);
  assert.match(threeLayer, /dispatch-execution-contract-entry\.js/);
  assert.match(threeLayer, /dispatch-transport\.js/);
  assert.match(threeLayer, /dispatch-graph-policy\.js/);
  assert.doesNotMatch(threeLayer, /lib\/ingress\/ingress\.js/);
  assert.doesNotMatch(threeLayer, /lib\/ingress\/ingress-standard-route\.js/);
  assert.doesNotMatch(threeLayer, /lib\/routing\/dispatch\.js/);
  assert.doesNotMatch(threeLayer, /lib\/routing\/graph-router\.js/);

  assert.match(delivery, /delivery:terminal/);
  assert.match(delivery, /delivery:system_action_contract_result/);
  assert.match(delivery, /delivery:system_action_assign_task_result/);
  assert.match(delivery, /delivery:system_action_review_verdict/);
  assert.doesNotMatch(delivery, /delivery:systemaction\b/);
  assert.doesNotMatch(delivery, /收编被 session management 实现阻塞/);
  assert.doesNotMatch(delivery, /delivery\.js \+ delivery-targets\.js 合并尚未执行/);

  assert.doesNotMatch(bridgeDecision, /Session management 尚未实现/);
  assert.doesNotMatch(bridgeDecision, /依赖 session management 设计完成/);

  assert.doesNotMatch(status, /runtime-bridge 收编被阻塞/);
  assert.doesNotMatch(status, /delivery 统一被阻塞/);
});

test("active protocol consumers import protocol-registry instead of hardcoding runtime ids", async () => {
  const [dashboardSource, platformDocSource] = await Promise.all([
    readProjectFile("dashboard.js"),
    readProjectFile("lib", "platform-doc-builder.js"),
  ]);

  assert.match(dashboardSource, /from ['"]\.\/protocol-registry\.js['"]/);
  assert.match(platformDocSource, /from ['"]\.\.\/protocol-registry\.js['"]/);

  assert.doesNotMatch(dashboardSource, /workflow !== 'delivery:terminal'/);
  assert.doesNotMatch(platformDocSource, /`delivery:terminal`/);
  assert.doesNotMatch(platformDocSource, /`delivery:system_action_assign_task_result`/);
  assert.doesNotMatch(platformDocSource, /`delivery:system_action_contract_result`/);
  assert.doesNotMatch(platformDocSource, /`delivery:system_action_review_verdict`/);
});
