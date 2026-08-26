// platform-service-toolface.js — 平台服务 FC 工具面 v1(镜像 collaboration-toolface.js 的形状)。
//
// 它解决的错配:平台能自己看见"盘上有没有产物",却**看不见** agent 这轮是失败了、
// 在等输入、还是主动挂起。v181 刀1 取消了「不写 outbox/runtime_result.json 就不采集」
// 的强制,但没取消那个文件的承重职责——于是"没读过文档的新 agent 进来能干活吗"这条
// 判据的答案一直卡在:能派活、能请审、能交产物,**表达不了失败**。
//
// 本模块把那一件事收成工具:agent 调 submit_output 声明结果,不必知道任何私有文件名。
//
// 边界(刻意不做的事):
// - **不跨 agent、不开票据、不查图边**。execute 直连本地 handler,不经 systemActionConsume——
//   那个汇合点解决的是授权/投递/回流,本族一件都不涉及,借道只会稀释它的语义。
// - **不接角色矩阵**。见 platform-service-tools.js 的表头注释。
// - **不取代产物采集**。artifacts 仍由 outbox 扫描决定;本工具只声明 status/summary。
//   声明 completed 也**不算数**——contract-outcome 仍要另判产物证据(那是刻意的:
//   LLM 会宣称自己完成了,唯一可信的是盘上有没有东西)。
// - **不删降级路**。`outbox/runtime_result.json` 保留为 L3:工具走不通时仍可写文件。
//   优先级是 L1 > L3,与协作族的梯子同构。

import { normalizeString } from "../core/normalize.js";
import { getTrackingState } from "../store/tracker-store.js";
import { isExposedPlatformServiceTool } from "./platform-service-tools.js";
import { wireDeclared } from "../archive/run-event-wiring.js";

// 与 stage-results.js 的 VALID_STAGE_RUN_STATUSES 同集。这里独立列出而不是 import,
// 是因为两者的**理由**不同:那边是"归一化时认哪些值",这里是"允许 agent 声明哪些值"。
// 将来若要禁止 agent 自称 completed(只让平台按产物证据判),改的是这里而不是那边。
const DECLARABLE_STATUSES = Object.freeze(["completed", "failed"]);

const TOOL_NAME = "submit_output";

// description 是这类工具性价比最高的调优点:模型**只**凭它决定调不调。三件事必须说清 ——
// ① 什么时候必须调(平台看不见的失败);② 什么时候不必调(正常完成有产物,平台自己看得见);
// ③ 调了不等于蒙混过关(声明 completed 仍要有产物,免得它把工具当交差捷径)。
const TOOL_DESCRIPTION = [
  "声明你这一轮的结果状态。平台能自己看见你在 outbox/ 里留下了什么产物,",
  "但看不见你这一轮是不是失败了 —— 失败必须用本工具说出来,否则平台会按产物证据自行推断。",
  "status=failed:这轮做不下去(给出 reason,让上游知道卡在哪;缺外部信息也用它,reason 写清缺什么)。",
  "status=completed:正常完成 —— 这一档可省略不调,平台会按产物证据判定;声明了也仍以盘上产物为准,没有产物不会因为声明而算完成。",
].join("");

const TOOL_PARAMETERS = Object.freeze({
  type: "object",
  properties: {
    status: {
      type: "string",
      enum: [...DECLARABLE_STATUSES],
      description: "本轮结果状态",
    },
    summary: {
      type: "string",
      description: "一句话说明这轮做了什么(进合约摘要,上游会读到)",
    },
    reason: {
      type: "string",
      description: "failed 时说明原因(缺什么、卡在哪);这是上游唯一能看到的解释",
    },
  },
  required: ["status"],
});

// 受理凭证:tool_result 的唯一形状。与协作族同构——accepted=true 表示平台已记下这次
// 声明,不代表合约已收口(终态仍要过 contract-outcome 的产物证据判定)。
export function buildSubmitOutputReceipt({ accepted, status = null, error = null, superseded = false }) {
  if (!accepted) {
    return {
      accepted: false,
      tool: TOOL_NAME,
      error,
      // 降级路的发现点挂在拒绝上,与协作族同款:教程不进主提示词(与工具并排会形成
      // 竞争性指令),只在工具真的走不通时才出现。
      fallback: "工具走不通时,可在 outbox/runtime_result.json 里写 "
        + '{"status":"<状态>","summary":"…"} 声明同一件事。',
    };
  }
  return {
    accepted: true,
    tool: TOOL_NAME,
    status,
    ...(superseded ? { superseded: true, note: "本轮此前已声明过,后到覆盖先到" } : {}),
    note: "已记下。产物仍以 outbox/ 里的实际文件为准。",
  };
}

export function buildPlatformServiceTools({ sessionKey, logger }) {
  if (!isExposedPlatformServiceTool(TOOL_NAME)) return [];

  return [{
    name: TOOL_NAME,
    label: "Submit Output",
    description: TOOL_DESCRIPTION,
    parameters: TOOL_PARAMETERS,
    async execute(_toolCallId, params = {}) {
      const status = normalizeString(params?.status)?.toLowerCase() || null;
      if (!status || !DECLARABLE_STATUSES.includes(status)) {
        const receipt = buildSubmitOutputReceipt({
          accepted: false,
          error: `status must be one of: ${DECLARABLE_STATUSES.join(", ")}`,
        });
        return { content: [{ type: "text", text: JSON.stringify(receipt, null, 2) }], details: receipt };
      }

      // 落点:本轮会话的 tracking state。不物化成文件——写文件正是本工具要消灭的东西。
      // 采集侧(collectRuntimeResult)在 agent_end 读它,优先于 runtime_result.json。
      const trackingState = getTrackingState(sessionKey);
      if (!trackingState) {
        const receipt = buildSubmitOutputReceipt({
          accepted: false,
          error: "no active tracking session for this call",
        });
        logger?.warn?.(`[platform-service] ${TOOL_NAME}: no tracking state for sessionKey=${sessionKey}`);
        return { content: [{ type: "text", text: JSON.stringify(receipt, null, 2) }], details: receipt };
      }

      // 后到覆写先到(与 stagePlan 三源覆写同一取舍:信息量单调递增)。
      const superseded = Boolean(trackingState.submittedOutput);
      trackingState.submittedOutput = {
        status,
        summary: normalizeString(params?.summary) || null,
        reason: normalizeString(params?.reason) || null,
      };
      logger?.info?.(
        `[platform-service] ${TOOL_NAME}(${trackingState.agentId || "?"}): status=${status}`
        + (superseded ? " (superseded an earlier declaration)" : ""),
      );
      // 事件接线(批② §八):submit_output 落 trackingState = declared 时刻。
      // fire-and-forget;后到覆写先到 → 账面留两条 declared,投影按 seq 取末条。
      void wireDeclared({
        contract: trackingState.contract,
        agentId: trackingState.agentId,
        sessionKey,
        status,
        logger,
      });

      const receipt = buildSubmitOutputReceipt({ accepted: true, status, superseded });
      return { content: [{ type: "text", text: JSON.stringify(receipt, null, 2) }], details: receipt };
    },
  }];
}

export function listPlatformServiceToolFaceNames() {
  return buildPlatformServiceTools({ sessionKey: null, logger: null }).map((tool) => tool.name);
}
