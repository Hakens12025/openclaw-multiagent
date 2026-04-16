import test from "node:test";
import assert from "node:assert/strict";

import { evaluateOutputValidation } from "../lib/test-output-validation.js";

test("output validation checks keywords against the full content body", () => {
  const content = `${"前言".repeat(140)}天气趋势`;
  const result = evaluateOutputValidation({
    content,
    validate: {
      minBytes: 10,
      keywords: ["天气", "趋势"],
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "PASS");
});

test("output validation returns the configured size failure code", () => {
  const result = evaluateOutputValidation({
    content: "short",
    validate: {
      minBytes: 10,
    },
    sizeFailureCode: "E_TOO_SMALL",
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, "E_TOO_SMALL");
});

test("output validation returns the configured keyword failure code", () => {
  const result = evaluateOutputValidation({
    content: "只有天气，没有别的",
    validate: {
      keywords: ["天气", "趋势"],
    },
    keywordFailureCode: "E_KEYWORD_MISSING",
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, "E_KEYWORD_MISSING");
  assert.deepEqual(result.missingKeywords, ["趋势"]);
});
