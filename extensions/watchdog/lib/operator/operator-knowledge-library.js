import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";

import { compactText, normalizeString } from "../core/normalize.js";
import { listOperatorKnowledgeSkillDocSpecs } from "../semantic-skill-registry.js";
import { OC } from "../state.js";

const USE_GUIDE_DIR = join(OC, "use guide");
const TEST_REPORTS_DIR = join(OC, "test-reports");
const OPERATOR_KNOWLEDGE_CACHE_TTL_MS = 10000;
const MAX_NOTE_EXCERPT_LENGTH = 260;
const MAX_NOTE_TITLE_LENGTH = 120;
const MAX_NOTES_PER_DOC = 2;
const MAX_DOCS_PER_QUERY = 3;
const MAX_ACTIVE_MASTER_MEMOS = 12;

const STATIC_DOC_SPECS = Object.freeze([
  {
    id: "claude-charter",
    title: "Project Charter",
    sourcePath: "CLAUDE.md",
    absolutePath: join(OC, "CLAUDE.md"),
    priority: 8,
    tags: ["第一原则", "llm", "代码负责流程", "runtime", "硬路径", "state machine", "状态机", "routing", "调度"],
  },
]);

let knowledgeCorpusCache = null;
let knowledgeCorpusCacheAt = 0;
let knowledgeCorpusPromise = null;

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function tokenizeRequest(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (!normalized) return {
    normalized,
    tokens: [],
  };
  return {
    normalized,
    tokens: normalized.split(/[^a-z0-9\u4e00-\u9fff_-]+/g).filter(Boolean),
  };
}

function stripMarkdownNoise(value) {
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

function extractHeaderSummary(markdown) {
  const match = String(markdown || "").match(/<!--[\s\S]*?摘要：([^\n]+)[\s\S]*?-->/);
  return compactText(match?.[1] || "", MAX_NOTE_EXCERPT_LENGTH);
}

function splitMarkdownSections(markdown) {
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

function extractTitleTags(title) {
  return uniqueStrings((String(title || "").match(/[A-Za-z][A-Za-z0-9_-]+|[\u4e00-\u9fff]{2,8}/g) || [])
    .map((item) => normalizeString(item))
    .filter(Boolean));
}

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : []).map((item) => normalizeString(item)).filter(Boolean))];
}

async function listActiveMasterMemoSpecs() {
  let entries = [];
  try {
    entries = await readdir(USE_GUIDE_DIR, { withFileTypes: true });
  } catch {
    return [];
  }

  const names = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => name.endsWith(".md"))
    .filter((name) => name.includes("[主]"))
    .filter((name) => !name.startsWith("[过时]"))
    .sort((a, b) => a.localeCompare(b, "zh-Hans-CN"))
    .slice(-MAX_ACTIVE_MASTER_MEMOS);

  return names
    .map((name) => ({
      id: `memo:${name}`,
      title: basename(name, ".md"),
      sourcePath: `use guide/${name}`,
      absolutePath: join(USE_GUIDE_DIR, name),
      priority: /operator|loop|图|地图|协议/i.test(name) ? 8 : 6,
      tags: extractTitleTags(name),
    }));
}

async function listRecentTestReportSpecs(limit = 3) {
  let entries = [];
  try {
    entries = await readdir(TEST_REPORTS_DIR, { withFileTypes: true });
  } catch {
    return [];
  }

  const txtFiles = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => name.endsWith(".txt"));

  const withMtime = await Promise.all(txtFiles.map(async (name) => {
    const fullPath = join(TEST_REPORTS_DIR, name);
    const st = await stat(fullPath).catch(() => null);
    return st ? { name, fullPath, mtimeMs: st.mtimeMs } : null;
  }));

  return withMtime
    .filter(Boolean)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, limit)
    .map((entry) => ({
      id: `test-report-${entry.name}`,
      title: basename(entry.name, ".txt").replace(/[-_]+/g, " "),
      sourcePath: `test-reports/${entry.name}`,
      absolutePath: entry.fullPath,
      priority: 5,
      tags: ["test", "report", "pass", "fail", "regression"],
    }));
}

function buildDocumentNotes(spec, markdown) {
  const notes = [];
  const docTitle = normalizeText(spec?.title);
  const sourcePath = normalizeText(spec?.sourcePath);
  const headerSummary = extractHeaderSummary(markdown);
  if (headerSummary) {
    notes.push({
      docId: spec.id,
      title: docTitle,
      sourcePath,
      heading: "摘要",
      excerpt: headerSummary,
      priority: Number.isFinite(spec?.priority) ? spec.priority + 1 : 1,
      tags: uniqueStrings([...(spec?.tags || []), "摘要"]),
    });
  }

  for (const section of splitMarkdownSections(markdown)) {
    const excerpt = compactText(section.text, MAX_NOTE_EXCERPT_LENGTH);
    if (!excerpt) continue;
    notes.push({
      docId: spec.id,
      title: docTitle,
      sourcePath,
      heading: compactText(section.heading || "Section", MAX_NOTE_TITLE_LENGTH),
      excerpt,
      priority: Number.isFinite(spec?.priority) ? spec.priority : 1,
      tags: uniqueStrings([...(spec?.tags || []), ...extractTitleTags(section.heading || "")]),
    });
  }
  return notes;
}

async function loadKnowledgeCorpus() {
  if (knowledgeCorpusCache && (Date.now() - knowledgeCorpusCacheAt) < OPERATOR_KNOWLEDGE_CACHE_TTL_MS) {
    return knowledgeCorpusCache;
  }
  if (knowledgeCorpusPromise) return knowledgeCorpusPromise;

  knowledgeCorpusPromise = (async () => {
    const specs = [
      ...STATIC_DOC_SPECS,
      ...listOperatorKnowledgeSkillDocSpecs().map((spec) => ({
        ...spec,
        absolutePath: join(OC, spec.sourcePath),
      })),
      ...(await listActiveMasterMemoSpecs()),
      ...(await listRecentTestReportSpecs()),
    ];

    const noteGroups = await Promise.all(specs.map(async (spec) => {
      const markdown = await readFile(spec.absolutePath, "utf8").catch(() => "");
      if (!markdown) return [];
      return buildDocumentNotes(spec, markdown);
    }));

    const corpus = noteGroups.flat();
    knowledgeCorpusCache = corpus;
    knowledgeCorpusCacheAt = Date.now();
    return corpus;
  })();

  try {
    return await knowledgeCorpusPromise;
  } finally {
    knowledgeCorpusPromise = null;
  }
}

function scoreKnowledgeNote(note, request) {
  let score = Number.isFinite(note?.priority) ? note.priority : 0;
  const searchText = `${normalizeText(note?.title)} ${normalizeText(note?.heading)} ${normalizeText(note?.excerpt)}`.toLowerCase();

  for (const tag of Array.isArray(note?.tags) ? note.tags : []) {
    const normalizedTag = normalizeString(tag)?.toLowerCase();
    if (!normalizedTag) continue;
    if (request.normalized.includes(normalizedTag)) score += normalizedTag.length >= 3 ? 4 : 2;
    if (searchText.includes(normalizedTag)) score += 1;
  }

  for (const token of request.tokens) {
    if (!token || token.length < 2) continue;
    if (searchText.includes(token)) score += token.length >= 4 ? 3 : 1;
  }

  return score;
}

export async function retrieveOperatorKnowledgeNotes({
  requestText,
  limit = 4,
} = {}) {
  const request = tokenizeRequest(requestText);
  if (!request.normalized) return [];

  const corpus = await loadKnowledgeCorpus();
  const ranked = corpus
    .map((note) => ({
      ...note,
      score: scoreKnowledgeNote(note, request),
    }))
    .filter((note) => note.score > note.priority + 1);

  const topDocIds = [...new Map(ranked
    .sort((a, b) => b.score - a.score)
    .map((note) => [note.docId, note.score])).keys()]
    .slice(0, MAX_DOCS_PER_QUERY);
  const allowedDocIds = new Set(topDocIds);

  const notes = [];
  const docCounts = new Map();
  for (const note of ranked.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title, "zh-Hans-CN"))) {
    if (!allowedDocIds.has(note.docId)) continue;
    const count = docCounts.get(note.docId) || 0;
    if (count >= MAX_NOTES_PER_DOC) continue;
    notes.push({
      title: note.title,
      sourcePath: note.sourcePath,
      heading: note.heading,
      excerpt: note.excerpt,
    });
    docCounts.set(note.docId, count + 1);
    if (notes.length >= limit) break;
  }
  return notes;
}
