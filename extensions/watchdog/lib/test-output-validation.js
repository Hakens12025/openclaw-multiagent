function normalizeValidation(validate) {
  return validate && typeof validate === "object" ? validate : null;
}

export function evaluateOutputValidation({
  content = "",
  validate = null,
  sizeFailureCode = "E_OUTPUT_MISSING",
  keywordFailureCode = "E_KEYWORD_MISSING",
} = {}) {
  const normalizedContent = typeof content === "string" ? content : String(content || "");
  const rules = normalizeValidation(validate);
  const size = Buffer.byteLength(normalizedContent, "utf8");

  if (!rules) {
    return { ok: true, status: "PASS", size, missingKeywords: [] };
  }

  const minBytes = Number.isFinite(rules.minBytes) ? rules.minBytes : 0;
  if (size < minBytes) {
    return {
      ok: false,
      status: sizeFailureCode,
      size,
      missingKeywords: [],
    };
  }

  const keywords = Array.isArray(rules.keywords) ? rules.keywords : [];
  const missingKeywords = keywords.filter((keyword) => !normalizedContent.includes(keyword));
  if (missingKeywords.length > 0) {
    return {
      ok: false,
      status: keywordFailureCode,
      size,
      missingKeywords,
    };
  }

  return {
    ok: true,
    status: "PASS",
    size,
    missingKeywords: [],
  };
}
