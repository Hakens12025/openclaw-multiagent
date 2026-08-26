// lib/core/markdown-sections.js — shared markdown chunker.
//
// Single source for splitting a markdown doc into heading-scoped sections and
// for stripping markdown noise (front-matter / code fences / links / tables).
// Extracted verbatim from the retired operator knowledge library (the
// lexical knowledge path) so the lexical retriever and the wiki-RAG store chunk
// IDENTICALLY — one chunker, no divergence between the two retrieval paths.

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

export function stripMarkdownNoise(value) {
  return String(value || "")
    // 无 /m:本规则的语义是"剥文档顶部的 front-matter",必须锚在字符串第 0 位。
    // 曾经带 /m,语义被悄悄改成"删掉本 section 里前两条 --- 之间的一切"——与下面
    // extractFrontMatter(:同文件)用同一 pattern 却不带 /m 的定义自相矛盾。
    // 全量实测(wiki 60 页 / memos 150 篇):/m 才命中的 section = 0,以 --- 开头的文件 = 0
    // → 删 /m 后 chunk 文本逐字节不变 = 零 re-embed。未引爆只是因为作者习惯把 --- 紧贴 ## 写,
    // 而 #### 不是切段边界(splitMarkdownSections 只认 #{1,3}):实测 8 篇同时用 #### 和独立 ---,
    // 只要有一篇把 --- 挪到 #### 下面,整段正文就会被静默吞掉。
    .replace(/^---\s*\n[\s\S]*?\n---\s*/, " ")
    .replace(/```[\s\S]*?```/g, " ")
    // 只剥 <!-- --> 两个标记、保留内部文本($1)。旧写法 /^<!--[\s\S]*?-->/ 把整块删了:
    // 实测 128/150 篇备忘录以 <!-- 开头,共 104,693 字符的结构化元数据头(摘要/涉及文件/状态/创建)
    // 被整体丢弃——其中 128 篇含"状态:"、125 篇含"涉及文件:",是这批文档唯一的元数据来源。
    // 同时去掉 ^ 锚 + 加 /g:旧写法只吃字符串第 0 字节,当前 0 泄漏纯属运气(实测 128 篇恰好
    // 每篇只有一个注释且都在第 1 行);任何一篇把注释写到第二段,标记就会以字面量进索引。
    .replace(/<!--([\s\S]*?)-->/g, " $1 ")
    .replace(/!\[[^\]]*]\([^)]*\)/g, " ")
    // 链接**整条丢弃**(文字也不留)——经 24 例 fixture 三变体受控 A/B 实测定的,不是想当然:
    //   丢弃(本行)   r@1 75.0 · r@3 91.7 · MRR 0.847   ← 采用
    //   保留链接文字  r@1 66.7 · r@3 79.2 · MRR 0.772   ← 24 例里 6 例名次下降、0 例上升
    //   旧的漏捕获组  r@1 75.0 · r@3 95.8 · MRR 0.844,但往语料灌了 101 块字面量 "$1"
    // 为什么"保留文字"反而更差:本语料里链接绝大多数长在「## 和谁交互」「| 页面 | 摘要 |」这类
    // **导航位**,不是行内散文。把 [三层协议](x) 还原成「三层协议」,等于让每个*提到*该概念的页
    // 都拿到这个词,与*定义*它的页抢排名 → 概念定义型查询的 top-1/top-3 被稀释(掉的 6 例全是这类)。
    // 旧 bug 的 "$1" 误打误撞起了同样的丢弃作用,只是顺手灌了垃圾。
    // ⚠ 作用域声明:上面这条"链接文字是导航不是内容"是**本语料的观察,不是普遍真理**。
    // 实测链接密度:wiki 276 条/60 页(4.60 篇均) vs memos 63 条/150 篇(0.42 篇均),差 11 倍
    // ——A/B 是在 wiki 这种高密度导航语料上做的。而本函数经 buildChunkPlanFromPages 服务**所有**
    // 用户 KB(wiki-rag-store.js);用户导入 API 文档 / 参考手册时,链接文字往往就是正文实体名,
    // 整条丢弃会直接丢掉可检索内容。要改成 per-KB 可配前必须在目标语料上重跑 A/B,不要把这条当默认真理外推。
    .replace(/\[([^\]]+)]\([^)]*\)/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^[>#*-]\s+/gm, "")
    .replace(/^#{1,6}\s+/gm, "")
    // 表格分隔行(|---|---|)整行丢弃。必须排在下面 \| → " " 之前,一旦竖线没了就再也认不出来。
    // 实测:两库共 460 条分隔行,往 chunk 灌了 9,646 个横杠字符——纯噪音,还在啃 MAX_CHUNK_CHARS=1200 预算。
    // 用 -{2,} 而不是 -+:实测另有 27 行"含竖线且只由 -:| 空白组成但没有连续横杠"的行(单横杠占位单元格),
    // -+ 会把它们一起吃掉。实测 460 条分隔行 100% 带前导竖线,故要求行首(可缩进)必须是 |,进一步避开误伤。
    .replace(/^[ \t]*\|[-:| \t]*-{2,}[-:| \t]*$/gm, " ")
    .replace(/\|/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// 极简 front-matter 解析器:只吃文档最顶部的 `---\n key: value \n---` 平铺标量块。
// 0 外部依赖,fail-soft(无冒号/嵌套缩进/列表项的行直接跳过不抛)。给 Phase5 的 source/time
// 元数据提取做原料。**不改 stripMarkdownNoise**——它仍把 front-matter 当噪音从正文剥掉,
// 正文逐字节不变=chunk hash 不变=零 re-embed;本函数只在 page 级"另外抓一份"结构化 kv。
export function extractFrontMatter(content) {
  const text = String(content || "");
  const match = text.match(/^---\s*\n([\s\S]*?)\n---\s*/);
  if (!match) return {};
  const out = {};
  for (const rawLine of match[1].split("\n")) {
    if (/^\s+\S/.test(rawLine)) continue;          // 缩进(嵌套)行跳过
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("-")) continue; // 注释/列表项
    const colon = trimmed.indexOf(":");
    if (colon <= 0) continue;                       // 无 key 跳过
    const key = trimmed.slice(0, colon).trim();
    let value = trimmed.slice(colon + 1).trim();
    if (!key || !value) continue;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);                   // 去成对引号
    }
    out[key] = value;
  }
  return out;
}

export function splitMarkdownSections(markdown) {
  const text = String(markdown || "");
  const lines = text.split("\n");
  const sections = [];
  let currentHeading = null;
  let currentLevel = null;
  let buffer = [];

  function flush() {
    const raw = stripMarkdownNoise(buffer.join("\n"));
    if (!raw) return;
    sections.push({
      heading: currentHeading,
      level: currentLevel,
      text: raw,
    });
  }

  // 围栏感知:本函数**逐行**切段,且跑在 stripMarkdownNoise 之前,所以必须自己认代码围栏。
  // 不认的后果(实测):```bash 块里的 `# 无需代理` 被当成 H1 → 从围栏中间劈成两段,两半各剩
  // 奇数个 ``` 永远配不上 → stripMarkdownNoise 的 /```[\s\S]*?```/ 匹配不到,整段命令行原文
  // 当自然语言进了索引,还产出幽灵 heading(如 heading="无需代理",见 备忘录11_[主]_V7系统全貌:102)。
  // 全量实测:109 个 section 残留字面 ```,分布在 30 个文件,100% 落在 memos 侧。
  // 安全性:实测两库 0 个文件围栏行数为奇数、0 行同时出现两个 ```、0 个 ~~~ 围栏,
  // 所以这个布尔开关不会因源文档不平衡而把后半篇吞成一段。
  let inFence = false;
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      buffer.push(line);
      continue;
    }
    const headingMatch = inFence ? null : line.match(/^(#{1,3})\s+(.+)$/);
    if (headingMatch) {
      flush();
      currentLevel = headingMatch[1].length;
      currentHeading = normalizeText(headingMatch[2]);
      buffer = [];
      continue;
    }
    buffer.push(line);
  }
  flush();
  return sections;
}
