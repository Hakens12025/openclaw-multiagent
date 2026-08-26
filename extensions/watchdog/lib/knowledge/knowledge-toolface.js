// knowledge-toolface.js — 检索 FC 工具面 v1(镜像 collaboration-toolface.js 的形状)。
//
// 它解决的错配:此前「有 RAG 的 agent 不能自主决定,能自主决定的 agent 没有 RAG」——
// 检索只存在于 operator/viz-master 的 grounding 里,且是 Promise.all 里的**无条件预注入**
// (operator-brain.js:318 / viz-master-brain.js:139),问什么都固定拉 4 条;而其余 8 个 agent
// 跑多轮 tool loop、有能力自己判断该不该查,却完全够不着知识库。
// 本模块把检索注册成 FC 工具,让 tool loop 里的 agent 自己决定调不调。
//
// 边界(刻意不做的事):
// - **不接管 operator/viz-master 的预注入**。那两条是单轮规划器(callPlannerWithSingleRetry,
//   错误码 PLANNER_JSON_PARSE_FAILED = 期望单轮出 JSON plan),没有 tool loop 可言,FC 在那里
//   物理上跑不起来。预注入对单轮规划器反而是对的形态,硬统一是为统一而统一。
// - **不新造检索**。execute 直接调 searchAgentKnowledge —— 与 grounding 预注入、
//   inspect.knowledge_agent_search 是同一条路径(一条路径原则)。
// - **不按 agentId 分支**。可见范围由「该 agent 绑定库 ∪ global」自然决定
//   (selectAgentKnowledgeBases),传送带原则:这里没有也不该有 if (agentId === "xxx")。

import { runtimeAgentConfigs } from "../state.js";
import { normalizeString } from "../core/normalize.js";
import { searchAgentKnowledge } from "./knowledge-base.js";

const TOOL_NAME = "search_knowledge";
const DEFAULT_TOP_K = 5;
const MAX_TOP_K = 10;
const MAX_EXCERPT_CHARS = 500;

// description 是这类系统里性价比最高的调优点:模型**只**凭它决定调不调。写法上三件事必须说清 ——
// ① 里面装的是什么(不说清则模型无从判断相关性);② 什么时候值得调(锚在"平台/项目私有、你训练时
// 见不到"这个边界上,而不是泛泛的"需要信息时");③ 查不到时怎么办(明确许可它说不知道,
// 否则模型倾向拿空结果硬编——这是检索型工具最常见的坏结局)。
const TOOL_DESCRIPTION = [
  "检索本平台的内部知识库(编译过的设计理由 wiki,以及本 agent 被绑定的其他知识库)。",
  "适合用它回答:这个平台的概念与术语、某个设计当初为什么这么定、模块边界与协作约定、内部流程规范 —— 这些是本项目私有的,不在你的训练知识里,靠推测会答错。",
  "通用编程知识、公开技术文档、你已经确知的事实,直接回答即可,不必检索。",
  "返回按相关度排序的片段,每条带来源路径。若结果为空或与问题对不上,如实说明知识库里没有相关记载,并据此继续 —— 这比据空结果推断更有用。",
].join("");

function buildEmptyPayload(reason) {
  return { ok: true, hitCount: 0, results: [], note: reason };
}

// 把检索结果压成模型友好的紧凑形状:只留来源、标题、正文摘录。score 刻意不外露 ——
// 跨库分数不可比(mergeAgentKbResults 的书面取舍),给模型看会诱导它当置信度用。
function toToolResult(searchResult) {
  const hits = Array.isArray(searchResult?.results) ? searchResult.results : [];
  if (hits.length === 0) {
    // 三种空要分开说。"这个 agent 一个库都没绑"是配置问题,报成"知识库里没有相关记载"
    // 会让 agent 得出错误结论(以为查过了、平台确实没记),故单独措辞。
    if ((searchResult?.bases || []).length === 0) return buildEmptyPayload("当前没有可供本 agent 检索的知识库");
    return buildEmptyPayload(
      searchResult?.degraded
        ? "检索降级(向量索引不可用,已退回词法检索)且无命中"
        : "知识库中没有与该问题匹配的内容",
    );
  }
  return {
    ok: true,
    hitCount: hits.length,
    ...(searchResult?.degraded ? { degraded: true, note: "向量索引不可用,本次为词法检索结果,相关度可能偏低" } : {}),
    results: hits.map((hit) => ({
      source: normalizeString(hit?.sourcePath) || "unknown",
      ...(normalizeString(hit?.kbId) ? { kb: normalizeString(hit.kbId) } : {}),
      ...(normalizeString(hit?.heading) ? { title: normalizeString(hit.heading) } : {}),
      excerpt: normalizeString(hit?.text).slice(0, MAX_EXCERPT_CHARS),
    })),
  };
}

function clampTopK(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_TOP_K;
  return Math.min(MAX_TOP_K, Math.max(1, Math.floor(n)));
}

// **必须同步**:框架的 `resolved = entry.factory(params.context)` 不 await
// (dist/subagent-registry-*.js),返回 Promise 会被当成 [Promise] → 工具静默丢失。
// 所以"这个 agent 看得见哪些库"只能在 execute 里查(那里本来就是 async),不在工厂里查。
export function buildKnowledgeTools({ agentId, logger = null }) {
  const id = normalizeString(agentId);
  if (!id || !runtimeAgentConfigs.has(id)) return [];

  return [{
    name: TOOL_NAME,
    label: "Search Knowledge",
    description: TOOL_DESCRIPTION,
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "检索问题,用自然语言原样描述你想知道什么" },
        topK: { type: "number", description: `返回条数,默认 ${DEFAULT_TOP_K},上限 ${MAX_TOP_K}` },
      },
      required: ["query"],
    },
    async execute(_toolCallId, params = {}) {
      const query = normalizeString(params?.query);
      // 检索永不抛:知识库不可用时 agent 应当继续干活并如实说明,而不是让整轮 tool call 失败。
      const payload = query
        ? await searchAgentKnowledge(id, query, { topK: clampTopK(params?.topK), includeGlobal: true })
            .then(toToolResult)
            .catch((error) => {
              logger?.warn?.(`[watchdog] search_knowledge failed (${id}): ${error?.message || error}`);
              return buildEmptyPayload("检索暂时不可用");
            })
        : buildEmptyPayload("query 为空");
      return {
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
        details: payload,
      };
    },
  }];
}

export function listKnowledgeToolNames() {
  return [TOOL_NAME];
}
