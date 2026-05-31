// agent-group-spec.js — AgentGroup 宏（macro），非 runtime 对象。
//
// 设计（备忘录 85/86）：AgentGroup 是装配层的宏，展开后「消失」在
//   graph(显式 EdgeSpec) + binding(outputPolicy) + GroupSession(运行层追踪) 里。
//   平台不获得任何新的 runtime 语义——dispatcher 完全感知不到「这条边来自 group」，
//   只看到 EdgeSpec + binding policy。
//
// 三权分立：本文件 = GroupSpec（装配层，纯函数 validate + 展开）。
//   GroupSession（运行层）在 group-session-store.js，两者分开不融合。
//
// 红线：
//   - 组内协作走显式 EdgeSpec（每条带 metadata.groupId），经既有 graph 授权，
//     不开 group-internal 免授权暗门。
//   - 不造新 transport：展开的边和普通 edge 平等进 agent-graph，走既有
//     loadGraph/dispatch 授权 + 排队。
//   - 不在 dispatch 里写 if-group：三输出模式语义由 outputPolicy + GroupSession 实现。
//
// 复用既有原语：normalizeGraphEdges（边去重/normalize）、normalizeString/
//   uniqueStrings（normalize 核心）。不另造 schema 风格。

import { normalizeGraphEdges } from "./agent-graph.js";
import { normalizeRecord, normalizeString, uniqueStrings } from "../core/normalize.js";

const OUTPUT_MODES = Object.freeze(["passthrough", "aggregate", "race"]);
const DEFAULT_OUTPUT_MODE = "aggregate";

function normalizeInternalEdge(value, memberSet) {
  const record = normalizeRecord(value, null);
  if (!record) return null;
  const from = normalizeString(record.from);
  const to = normalizeString(record.to);
  if (!from || !to) return null;
  // 红线：组内边的两端必须是 group 成员（否则不是「组内协作」，且会污染拓扑）。
  if (!memberSet.has(from) || !memberSet.has(to)) return null;
  return { from, to };
}

/**
 * 校验并归一化 GroupSpec（装配层）。
 *
 * @param {{
 *   id?: string,
 *   members?: string[],
 *   entry?: string,
 *   internalEdges?: Array<{ from: string, to: string }>,
 *   outputMode?: "passthrough" | "aggregate" | "race",
 *   metadata?: object,
 * }} value
 * @returns {{
 *   id: string, members: string[], entry: string,
 *   internalEdges: Array<{ from, to }>, outputMode: string, metadata: object | null,
 * } | null}  无效（无 id / 成员 < 2 / outputMode 非法）→ null（不静默猜测）。
 */
export function normalizeGroupSpec(value) {
  const source = normalizeRecord(value, null);
  if (!source) return null;

  const id = normalizeString(source.id);
  const members = uniqueStrings(source.members);
  if (!id || members.length < 2) return null;

  const outputMode = OUTPUT_MODES.includes(source.outputMode)
    ? source.outputMode
    : (source.outputMode == null ? DEFAULT_OUTPUT_MODE : null);
  if (!outputMode) return null;

  const memberSet = new Set(members);
  const entryCandidate = normalizeString(source.entry);
  const entry = entryCandidate && memberSet.has(entryCandidate) ? entryCandidate : members[0];

  const internalEdges = (Array.isArray(source.internalEdges) ? source.internalEdges : [])
    .map((edge) => normalizeInternalEdge(edge, memberSet))
    .filter(Boolean);

  return {
    id,
    members,
    entry,
    internalEdges,
    outputMode,
    metadata: normalizeRecord(source.metadata, null),
  };
}

// 三输出模式 → 每成员 outputPolicy（binding 层，由下游 aggregation handler 消费，
// dispatch 不碰）：
//   passthrough — 每成员各自输出直连下游（format: passthrough）。
//   aggregate   — entry（组级聚合点）等齐汇总走组级出边（aggregateGroup），其余成员 passthrough。
//   race        — 先合格者胜出（GroupSession 标记取消其余）；entry 走 aggregateGroup 收口胜者，
//                 其余成员 passthrough（与 aggregate 同形，差异在 GroupSession 等齐 vs 先得判定）。
function buildOutputPolicies(spec) {
  const policies = {};
  for (const member of spec.members) {
    policies[member] = { format: "passthrough" };
  }
  if (spec.outputMode === "aggregate" || spec.outputMode === "race") {
    policies[spec.entry] = { format: "contract-json", aggregateGroup: spec.id };
  }
  return policies;
}

/**
 * 宏展开：GroupSpec → ① 显式 EdgeSpec[]（带 metadata.groupId/direction/outputMode）
 *   ② 每成员 outputPolicy ③ GroupSession 描述符（运行层，与 spec 分开）。
 *
 * 纯函数、无 IO、幂等：同 spec 展开同 edges（normalizeGraphEdges 去重稳定）。
 * 展开后的边和普通 edge 平等——调用方把 edges 合并进 graph.edges 即可，
 * 走既有 loadGraph/dispatch 授权链路；不造新 loader、不造新 transport。
 *
 * @param {object} groupSpecInput  原始 GroupSpec（会先经 normalizeGroupSpec）
 * @returns {{
 *   edges: Array<{from,to,label,metadata}>,
 *   outputPolicies: Record<agentId, {format, aggregateGroup?}>,
 *   groupSession: { groupId, members, entryAgentId, outputMode, metadata } | null,
 * }}
 */
export function expandAgentGroup(groupSpecInput) {
  const spec = normalizeGroupSpec(groupSpecInput);
  if (!spec) {
    return { edges: [], outputPolicies: {}, groupSession: null };
  }

  const rawEdges = spec.internalEdges.map((edge) => ({
    from: edge.from,
    to: edge.to,
    metadata: { groupId: spec.id, direction: "internal", outputMode: spec.outputMode },
  }));

  return {
    // 复用 normalizeGraphEdges：与原生边走同一 normalize 链路（去重 + validate）。
    edges: normalizeGraphEdges(rawEdges),
    outputPolicies: buildOutputPolicies(spec),
    // GroupSession 描述符：运行层种子，不携带装配层 internalEdges（spec/session 分开）。
    groupSession: {
      groupId: spec.id,
      members: spec.members,
      entryAgentId: spec.entry,
      outputMode: spec.outputMode,
      metadata: spec.metadata,
    },
  };
}
