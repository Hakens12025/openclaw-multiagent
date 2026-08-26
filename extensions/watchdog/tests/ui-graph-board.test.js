import test from "node:test";
import assert from "node:assert/strict";
import { autoLayout, renderGraphBoard } from "../ui/components/graph-board.js";
import { createI18n } from "../ui/core/i18n.js";

const i18n = createI18n({ lang: "en-US" });

const model = {
  nodes: [
    { id: "bridge", role: "bridge", status: "idle" },
    { id: "planner", role: "planner", status: "active" },
    { id: "worker-a", role: "executor", status: "active" },
  ],
  edges: [
    { from: "bridge", to: "planner" },
    { from: "planner", to: "worker-a" },
  ],
  flows: [{ from: "planner", to: "worker-a", label: "c-1" }],
  queues: { "worker-a": 3 },
};

test("graph-board: 节点/边/合约卡/排队堆叠数量正确", () => {
  const html = renderGraphBoard(model, i18n.t);
  assert.match(html, /^<svg/);
  assert.equal((html.match(/class="gb-node-box/g) || []).length, 3, "3 个节点卡");
  assert.equal((html.match(/class="gb-edge"/g) || []).length, 2, "2 条边");
  assert.equal((html.match(/<g class="contract-card"/g) || []).length, 1, "1 张流动合约卡");
  assert.match(html, /offset-path: path\('M/);
  assert.equal((html.match(/class="gb-queue-card"/g) || []).length, 3, "3 张排队堆叠卡");
});

test("graph-board: 状态方标语义 + 接收方吸入态", () => {
  const html = renderGraphBoard(model, i18n.t);
  assert.equal((html.match(/gb-status-sq is-active/g) || []).length, 2);
  assert.equal((html.match(/gb-status-sq is-idle/g) || []).length, 1);
  assert.match(html, /gb-node-box[^"]*\bis-receiving\b/, "flow 目标节点带吸入动画类");
});

test("graph-board: 空态", () => {
  const html = renderGraphBoard({ nodes: [], edges: [], flows: [], queues: {} }, i18n.t);
  assert.match(html, /gb-empty/);
});

test("graph-board: 连线编辑渲染契约 — 命中区/环高亮/选源态/编辑态", () => {
  const model2 = {
    nodes: model.nodes,
    edges: model.edges,
    flows: [],
    queues: {},
    cycles: [["bridge", "planner", "bridge"]],
  };
  const html = renderGraphBoard(model2, i18n.t, { editMode: true, selectedId: "planner" });
  // 每条边一个宽透明命中区（右键删除落点），data-edge 可解析
  assert.equal((html.match(/class="gb-edge-hit"/g) || []).length, 2);
  assert.match(html, /data-edge="bridge\|planner"/);
  // 环上的边叠砖红高亮层；不在环上的边没有
  assert.equal((html.match(/class="gb-cycle"/g) || []).length, 1);
  // 选源节点高亮 + 编辑态类（类序不固定，按词断言）
  assert.match(html, /gb-node-box[^"]*\bis-source\b/);
  assert.match(html, /is-edit/);
});

test("graph-board: 队列读数(等宽)随堆叠渲染", () => {
  const html = renderGraphBoard(model, i18n.t);
  assert.match(html, /class="gb-queue-count"[^>]*>QUEUE 3</);
});

test("graph-board: autoLayout — 保存位为锚，未存节点避开落位", () => {
  const nodes = [
    { id: "bridge", role: "bridge" },
    { id: "planner", role: "planner" },
    { id: "worker-a", role: "executor" },
  ];
  const saved = { planner: { x: 20, y: 30 } }; // planner 占左列首格（10px 网格对齐值）
  const pos = autoLayout(nodes, saved);
  assert.deepEqual(pos.planner, { x: 20, y: 30, w: 160, h: 78 }, "保存位原样为锚");
  // bridge 同列被挤到下一档（28 起步 → 撞锚 +SLOT_H → snap 到 130），worker-a 在中列首格
  assert.equal(pos["bridge"].x, 20);
  assert.equal(pos["bridge"].y, 130);
  assert.equal(pos["worker-a"].x, 270);
  assert.equal(pos["worker-a"].y, 30);
  // 无保存位时：纯两列（TOP_Y=28 snap 到 30）
  const fresh = autoLayout(nodes, {});
  assert.equal(fresh.bridge.y, 30);
  assert.equal(fresh.planner.y, 130);
});
