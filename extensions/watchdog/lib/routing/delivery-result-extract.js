// delivery-result-extract.js — user-facing text extraction from runtime artifacts
//
// Pure text extraction helpers. No file I/O, no state dependencies.
// Leaf module — no imports from other routing modules.

const USER_FACING_RESULT_LABEL_PATTERN = "(?:回复内容|响应内容|最终回答|回答|用户回复|执行结果|交付内容)";

const INTERNAL_DELIVERY_REASON_RE = /runtime_result|contract\.output|completion_criteria|missing runtime|missing required artifact|runtime-observed artifact|未满足 contract/iu;

export function isInternalDeliveryReason(text) {
  return INTERNAL_DELIVERY_REASON_RE.test(String(text || ""));
}

function cleanUserFacingBlock(text) {
  const lines = String(text || "")
    .split("\n")
    .map((line) => line.trimEnd());
  const result = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^-{3,}$/.test(trimmed)) break;
    if (/^#{1,6}\s+/.test(trimmed)) break;
    if (/^\*?此(?:响应|消息).*(?:OpenClaw|worker)/iu.test(trimmed)) break;
    result.push(line);
  }
  return result.join("\n").trim();
}

function extractAnswerAfterLine(lines, startIndex, firstLine = "") {
  const collected = [];
  if (firstLine.trim()) collected.push(firstLine.trim());
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed && collected.length === 0) continue;
    if (/^-{3,}$/.test(trimmed)) break;
    if (/^#{1,6}\s+/.test(trimmed)) break;
    if (/^\*?此(?:响应|消息).*(?:OpenClaw|worker)/iu.test(trimmed)) break;
    collected.push(line);
  }
  return cleanUserFacingBlock(collected.join("\n"));
}

function extractInlineLabeledUserFacingResult(text) {
  const normalized = String(text || "").trim();
  if (!normalized) return "";
  const labelRegex = new RegExp(`${USER_FACING_RESULT_LABEL_PATTERN}\\s*[:：]?\\s*`, "iu");
  const match = normalized.match(labelRegex);
  if (!match || typeof match.index !== "number") return "";
  const tail = normalized.slice(match.index + match[0].length);
  return cleanUserFacingBlock(
    tail
      .replace(/\s+---[\s\S]*$/u, "")
      .replace(/\s+\*?本文件由[\s\S]*$/u, "")
      .replace(/\s+\*?此(?:响应|消息)[\s\S]*$/u, ""),
  );
}

function stripMarkdownForAnswerExtraction(text) {
  return String(text || "")
    .replace(/\r\n?/gu, "\n")
    .replace(/```[\s\S]*?```/gu, " ")
    .replace(/^\s*#{1,6}\s*/gmu, "")
    .replace(/\*\*/gu, "")
    .replace(/[`_]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function removeInlineMetadata(text) {
  return String(text || "")
    .replace(/\bTC-[A-Za-z0-9_-]+\b/gu, " ")
    .replace(/(?:^|\s)(?:[-*]\s*)?(?:合约(?:编号|ID)|contract\s*id)\s*[:：]\s*[^\s，。；;]+/giu, " ")
    .replace(/(?:^|\s)(?:[-*]\s*)?(?:接收时间|执行时间|完成时间)\s*[:：]\s*\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}(?:\s*\([^)]+\))?/gu, " ")
    .replace(/(?:^|\s)(?:[-*]\s*)?(?:执行状态|任务状态|状态)\s*[:：]\s*(?:已完成|完成|completed|failed|失败|进行中|running|awaiting_input|awaiting input)/giu, " ")
    .replace(/(?:^|\s)(?:[-*]\s*)?(?:执行节点|处理节点|agent|worker)\s*[:：]\s*[A-Za-z0-9_-]+/giu, " ")
    .replace(/(?:任务信息|合约信息|执行信息)\s*[:：]?/gu, " ")
    .replace(/(?:^|\s)[-*]\s*/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function splitSentences(text) {
  return String(text || "")
    .match(/[^。！？!?]+[。！？!?]?/gu)
    ?.map((part) => part.trim())
    .filter(Boolean) || [];
}

function isMetadataSentence(sentence) {
  const normalized = String(sentence || "").trim();
  if (!normalized) return true;
  if (/^(?:任务响应|问候响应|执行结果|响应|结果|任务完成)$/u.test(normalized)) return true;
  if (/(?:合约(?:信息|ID|编号)|任务信息|任务状态|执行状态|接收时间|执行时间|完成时间|执行节点|处理节点|OpenClaw|runtime_result|\bworker\d*\b)/iu.test(normalized)) {
    return true;
  }
  if (/我是.{0,30}(?:执行节点|处理节点|worker)/iu.test(normalized)) {
    return true;
  }
  return false;
}

function trimLeadingArtifactTitle(text) {
  return String(text || "")
    .replace(/^(?:任务响应|问候响应|执行结果|响应|结果|任务完成)\s+/u, "")
    .trim();
}

function isArtifactLikelyMetadataHeavy(text) {
  return /(?:合约ID|合约编号|执行时间|任务信息|阶段[一二三四五六七八九十]|\bworker\d*\b|OpenClaw)/iu.test(String(text || ""));
}

function extractUnlabeledUserFacingResult(text) {
  const normalized = trimLeadingArtifactTitle(
    removeInlineMetadata(stripMarkdownForAnswerExtraction(text)),
  );
  if (!normalized) return "";

  const sentences = splitSentences(normalized);
  if (sentences.length === 0) return "";

  let lastMetadataIndex = -1;
  for (let index = 0; index < sentences.length; index += 1) {
    if (isMetadataSentence(sentences[index])) {
      lastMetadataIndex = index;
    }
  }

  const tail = sentences
    .slice(lastMetadataIndex + 1)
    .filter((sentence) => !isMetadataSentence(sentence))
    .join("");
  if (tail) return tail.trim();

  const cleanSentences = sentences.filter((sentence) => !isMetadataSentence(sentence));
  return cleanSentences.length > 0 ? cleanSentences[cleanSentences.length - 1].trim() : "";
}

export function extractUserFacingResultFromArtifact(text) {
  const raw = String(text || "").trim();
  if (!raw) return "";
  const lines = raw.split("\n");
  const labelPattern = new RegExp(`^\\s*(?:[-*]\\s*)?(?:\\*\\*)?${USER_FACING_RESULT_LABEL_PATTERN}(?:\\*\\*)?\\s*[:：]?\\s*(.*)$`, "iu");
  const headingPattern = new RegExp(`^\\s*#{1,6}\\s*${USER_FACING_RESULT_LABEL_PATTERN}\\s*[:：]?\\s*$`, "iu");

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (headingPattern.test(line)) {
      const extracted = extractAnswerAfterLine(lines, index);
      if (extracted) return extracted;
    }
    const labelMatch = line.match(labelPattern);
    if (labelMatch) {
      const extracted = extractAnswerAfterLine(lines, index, labelMatch[1] || "");
      if (extracted) return extracted;
    }
  }

  const inlineExtracted = extractInlineLabeledUserFacingResult(raw);
  if (inlineExtracted) return inlineExtracted;

  if (raw.length <= 600 && !isArtifactLikelyMetadataHeavy(raw)) {
    return raw;
  }
  return extractUnlabeledUserFacingResult(raw);
}
