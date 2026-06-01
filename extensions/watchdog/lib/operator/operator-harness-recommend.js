// operator-harness-recommend.js — #47 生成层: operator 据失败信号 + 模块库 派生 harness 定义。
//
// 混合(用户拍板 A+B):
//   - 动态(B): 有历史验证通过的 harness 模块组合 → 优先采用(用得越多越准)。
//   - 静态(A): 否则用模块库基线(4 kind 各一均衡组合) + 据失败信号针对性补强。
//
// 红线: operator 只产 **module 粒度**(moduleRefs)——不当第二 planner、不编 module 实现;
//   automation-registry merge 默认 config。纯函数, 无 IO, 便于单测。
//   "标准进 skill": 基线组合本身就是 catalog 派生的标准; 学得的好组合经 #39 skill 沉淀。

import { listHarnessModuleCatalog } from "../harness/harness-module-catalog.js";

// 静态基线: 4 个 kind 各取一个均衡默认(预算守卫 + 产物采集 + 产物门 + 失败归一)。
const BASELINE_MODULE_REFS = Object.freeze([
  "harness:guard.budget",
  "harness:collector.artifact",
  "harness:gate.artifact",
  "harness:normalizer.failure",
]);

// 失败信号关键词 → 针对性补强模块(按 catalog 的 hardShaped 语义对应)。
const FAILURE_HINT_MODULES = Object.freeze([
  { match: /test/i, moduleRef: "harness:gate.test" },
  { match: /schema/i, moduleRef: "harness:gate.schema" },
  { match: /trace|log/i, moduleRef: "harness:collector.trace" },
  { match: /tool|network/i, moduleRef: "harness:guard.tool_access" },
  { match: /scope|sandbox|workspace/i, moduleRef: "harness:guard.scope" },
]);

/**
 * 推荐一组 harness moduleRefs。
 * @param {{ failedModules?: string[], currentModuleRefs?: string[], pastSuccessfulCombos?: Array<string[]|{moduleRefs:string[]}> }} input
 * @returns {{ moduleRefs: string[], rationale: string, source: "learned"|"baseline" }}
 */
export function recommendHarnessModules({ failedModules = [], pastSuccessfulCombos = [] } = {}) {
  const catalogIds = new Set(listHarnessModuleCatalog().map((m) => m.id));

  // 动态(B): 取最近一个「全在 catalog 内」的历史成功组合。
  const learned = (Array.isArray(pastSuccessfulCombos) ? pastSuccessfulCombos : [])
    .map((combo) => (Array.isArray(combo) ? combo : combo?.moduleRefs))
    .find((refs) => Array.isArray(refs) && refs.length > 0 && refs.every((id) => catalogIds.has(id)));
  if (learned) {
    return {
      moduleRefs: [...learned],
      rationale: "采用历史验证通过的 harness 模块组合（动态学习）。",
      source: "learned",
    };
  }

  // 静态(A): 基线 + 失败信号补强。
  const refs = new Set(BASELINE_MODULE_REFS.filter((id) => catalogIds.has(id)));
  const augmented = [];
  for (const failed of Array.isArray(failedModules) ? failedModules : []) {
    const text = String(failed || "");
    for (const hint of FAILURE_HINT_MODULES) {
      if (hint.match.test(text) && catalogIds.has(hint.moduleRef) && !refs.has(hint.moduleRef)) {
        refs.add(hint.moduleRef);
        augmented.push(hint.moduleRef);
      }
    }
  }
  return {
    moduleRefs: [...refs],
    rationale: augmented.length
      ? `基线 harness（guard/collector/gate/normalizer 各一）+ 据失败信号补强 ${augmented.join(", ")}（静态推荐）。`
      : "基线 harness（guard/collector/gate/normalizer 各一，静态推荐）。",
    source: "baseline",
  };
}
