// 评测集防腐测试。
//
// 为什么需要它:评测集的 expectedSourcePath 是**手写字符串**,而语料是会改名的活文件
// —— 备忘录被判定过时后会加 `[过时]` 前缀(实测 150 篇里 30 篇已加),wiki 页会被移动/重命名。
// 改名后用例不会报错,只会永远算 miss,把"标注烂了"伪装成"检索退步"。实测代价:memos 首测
// 13 条未命中里有 3 条根本是标注缺陷(期望文件里 0 处答案 / 有更贴题的页 / 题目本身不成立),
// 若无本测试,这 3 条会被当成检索质量问题一路查下去。
//
// 真值来源:**不复制路径约定**。两个 KB 的 sourcePath 基准并不一致
// (wiki 相对 wiki/ → `decisions/x.md`;用户库相对 OC 根 → `use guide/x.md`,见
// wiki-rag-store.js:85 vs :246),测试里再抄一份就是第二真值。所以直接拿**索引里实际存在的
// sourcePath 集合**当真值:一个 expectedSourcePath 若不在索引中,它就物理上不可能被检回。
//
// 索引缺失时跳过(而不是失败):索引是构建产物,CI/新克隆环境不一定有。跳过会明确说明原因。

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadKnowledgeBaseIndex } from "../lib/knowledge/knowledge-base.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = [
  { file: "wiki-rag-eval-set.json", kbId: "wiki" },
  { file: "memos-rag-eval-set.json", kbId: "memos" },
];

async function loadFixture(name) {
  return JSON.parse(await readFile(join(HERE, "fixtures", name), "utf8"));
}

// 走 loadKnowledgeBaseIndex 而不是自己拼索引文件名:wiki 库复用 wiki-rag-index.json
// (control-plane-paths.js:49 的书面例外),自己按 kb-<id>-index.json 拼会拿到不存在的文件
// → 静默跳过 → 测试形同虚设。本文件初版就踩了这个坑,靠"wiki 跳过而 memos 通过"的不对称暴露。
async function loadIndexPaths(kbId) {
  try {
    const chunks = (await loadKnowledgeBaseIndex(kbId))?.chunks;
    if (!Array.isArray(chunks) || chunks.length === 0) return null;
    return new Set(chunks.map((c) => c?.sourcePath).filter(Boolean));
  } catch {
    return null;
  }
}

for (const { file, kbId } of FIXTURES) {
  test(`${file}: 期望路径在索引中真实存在`, async (t) => {
    const fx = await loadFixture(file);
    const known = await loadIndexPaths(kbId);
    if (!known) {
      t.skip(`kb '${kbId}' 索引缺失或为空 —— 跳过存在性校验(需先构建索引)`);
      return;
    }
    const dead = [];
    for (const c of fx.cases) {
      if (!known.has(c.expectedSourcePath)) dead.push(`expected: ${c.expectedSourcePath}`);
      for (const g of c.ghostSourcePaths || []) {
        if (!known.has(g)) dead.push(`ghost: ${g}`);
      }
    }
    assert.deepEqual(dead, [], `以下路径不在 kb '${kbId}' 索引里(改名/删除导致的死用例):\n  ${dead.join("\n  ")}`);
  });

  test(`${file}: 用例本身自洽`, async () => {
    const fx = await loadFixture(file);
    assert.ok(fx.cases.length > 0, "评测集不能为空");
    assert.ok(Number.isInteger(fx.topK) && fx.topK > 0, "topK 必须是正整数");

    const seen = new Set();
    for (const c of fx.cases) {
      assert.ok(c.query && typeof c.query === "string", "每例必须有 query");
      // 重复 query 会让 diffRecallRanks 的 Map 配对静默丢例(它以 query 为键)。
      assert.ok(!seen.has(c.query), `重复 query 会破坏逐例配对: ${c.query}`);
      seen.add(c.query);
      assert.ok(c.expectedSourcePath, `缺 expectedSourcePath: ${c.query}`);
      assert.ok(c.category, `缺 category(缺了就进不了 byCategory 分解): ${c.query}`);

      // expected 同时出现在 ghost 里,只有 undecided(弃权,不计 recall)才说得通 ——
      // 那表示"这题在本语料里只有过期答案"。非 undecided 时同时标两边是自相矛盾的标注。
      const ghosts = c.ghostSourcePaths || [];
      if (ghosts.includes(c.expectedSourcePath)) {
        assert.equal(c.verdictStatus, "undecided", `expected 与 ghost 重叠但未标 undecided: ${c.query}`);
      }
    }
  });
}
