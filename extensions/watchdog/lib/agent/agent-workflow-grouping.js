// agent-workflow-grouping.js — workflow = agent-graph 的无向连通分量（纯函数）
//
// 「工作流」前端页的拓扑真值：从 graph.edges（{from,to}）求无向连通分量，
// 覆盖 planner→worker→worker2 这类线性链；成环子图（detectCycles 认得的那种）也是其子集。
//
// 纯函数、无副作用、无 IO。surface（inspect.agent_workflows）在 inspector
// 里组合 loadGraph() 后调用本函数，不在此读 store（不造第二真值）。

/**
 * 从 graph.edges 求无向连通分量。
 *
 * @param {{ edges?: Array<{from:string,to:string}> }} graph
 * @returns {{
 *   workflows: Array<{ id:string, members:string[], entry:string }>,
 *   byAgent: Record<string, string>,
 * }}
 *
 * 规则：
 *   - 连通性按无向边计算（from/to 双向连通）。
 *   - 孤立节点（出现在 edges 端点但无连边的 from/to 也算节点；
 *     这里节点全集 = edges 的所有端点）也各自成 1 个分量。
 *   - id = "wf:" + 成员排序后 join("+")，稳定可复现。
 *   - entry = 分量内入度为 0 的节点（按排序取首个）；没有入度 0 的（如环）
 *     则取排序后首个成员。
 */
export function computeAgentWorkflows(graph) {
  const edges = Array.isArray(graph?.edges) ? graph.edges : [];

  // 节点全集 = 所有 edge 端点
  const nodes = new Set();
  // 无向邻接表（用于连通分量）
  const undirectedAdj = new Map();
  // 有向入度（用于 entry 推导）
  const inDegree = new Map();

  function ensureNode(id) {
    if (!nodes.has(id)) {
      nodes.add(id);
      undirectedAdj.set(id, new Set());
      inDegree.set(id, 0);
    }
  }

  for (const edge of edges) {
    const from = typeof edge?.from === "string" ? edge.from.trim() : "";
    const to = typeof edge?.to === "string" ? edge.to.trim() : "";
    if (!from || !to) continue;
    ensureNode(from);
    ensureNode(to);
    undirectedAdj.get(from).add(to);
    undirectedAdj.get(to).add(from);
    inDegree.set(to, inDegree.get(to) + 1);
  }

  // 无向 BFS 求连通分量
  const visited = new Set();
  const components = [];
  for (const node of nodes) {
    if (visited.has(node)) continue;
    const members = [];
    const queue = [node];
    visited.add(node);
    while (queue.length > 0) {
      const cur = queue.shift();
      members.push(cur);
      for (const nb of undirectedAdj.get(cur) || []) {
        if (!visited.has(nb)) {
          visited.add(nb);
          queue.push(nb);
        }
      }
    }
    members.sort();
    components.push(members);
  }

  // 稳定排序分量（按首成员），保证 workflows 顺序可复现
  components.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  const workflows = [];
  const byAgent = {};
  for (const members of components) {
    const id = `wf:${members.join("+")}`;
    // entry：入度 0 的成员（排序后取首个），无则取排序首个
    const zeroIn = members.filter((m) => inDegree.get(m) === 0);
    const entry = zeroIn.length > 0 ? zeroIn[0] : members[0];
    workflows.push({ id, members, entry });
    for (const m of members) {
      byAgent[m] = id;
    }
  }

  return { workflows, byAgent };
}
