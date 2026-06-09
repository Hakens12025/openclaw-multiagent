// lib/core/markdown-sections.js — shared markdown chunker.
//
// Single source for splitting a markdown doc into heading-scoped sections and
// for stripping markdown noise (front-matter / code fences / links / tables).
// Extracted verbatim from lib/operator/operator-knowledge-library.js (the
// lexical knowledge path) so the lexical retriever and the wiki-RAG store chunk
// IDENTICALLY — one chunker, no divergence between the two retrieval paths.

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

export function stripMarkdownNoise(value) {
  return String(value || "")
    .replace(/^---\s*\n[\s\S]*?\n---\s*/m, " ")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^<!--[\s\S]*?-->/, " ")
    .replace(/!\[[^\]]*]\([^)]*\)/g, " ")
    .replace(/\[[^\]]+]\([^)]*\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^[>#*-]\s+/gm, "")
    .replace(/^#{1,6}\s+/gm, "")
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

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,3})\s+(.+)$/);
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
