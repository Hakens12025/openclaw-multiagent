import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeString,
  normalizeRecord,
  normalizeBoolean,
  normalizeCount,
  normalizePositiveInteger,
  normalizeFiniteNumber,
  uniqueStrings,
  uniqueTools,
  normalizeEnum,
  getErrorMessage,
  compactText,
} from "../lib/core/normalize.js";

// ── normalizeString ─────────────────────────────────────────────────────────

test("normalizeString: trims and returns string", () => {
  assert.equal(normalizeString("  hello  "), "hello");
});

test("normalizeString: returns null for empty string", () => {
  assert.equal(normalizeString(""), null);
});

test("normalizeString: returns null for whitespace-only string", () => {
  assert.equal(normalizeString("   "), null);
});

test("normalizeString: returns null for null/undefined", () => {
  assert.equal(normalizeString(null), null);
  assert.equal(normalizeString(undefined), null);
});

test("normalizeString: returns null for non-string types", () => {
  assert.equal(normalizeString(42), null);
  assert.equal(normalizeString(true), null);
  assert.equal(normalizeString({}), null);
  assert.equal(normalizeString([]), null);
});

// ── normalizeRecord ─────────────────────────────────────────────────────────

test("normalizeRecord: returns object as-is", () => {
  const obj = { a: 1 };
  assert.equal(normalizeRecord(obj), obj);
});

test("normalizeRecord: returns fallback for null/undefined", () => {
  assert.deepEqual(normalizeRecord(null), {});
  assert.deepEqual(normalizeRecord(undefined), {});
});

test("normalizeRecord: returns fallback for array", () => {
  assert.deepEqual(normalizeRecord([1, 2]), {});
});

test("normalizeRecord: returns fallback for primitives", () => {
  assert.deepEqual(normalizeRecord("string"), {});
  assert.deepEqual(normalizeRecord(42), {});
  assert.deepEqual(normalizeRecord(true), {});
});

test("normalizeRecord: uses custom fallback", () => {
  const fb = { default: true };
  assert.equal(normalizeRecord(null, fb), fb);
});

// ── normalizeBoolean ────────────────────────────────────────────────────────

test("normalizeBoolean: boolean true/false pass through", () => {
  assert.equal(normalizeBoolean(true), true);
  assert.equal(normalizeBoolean(false), false);
});

test("normalizeBoolean: truthy string tokens", () => {
  assert.equal(normalizeBoolean("true"), true);
  assert.equal(normalizeBoolean("TRUE"), true);
  assert.equal(normalizeBoolean("yes"), true);
  assert.equal(normalizeBoolean("YES"), true);
  assert.equal(normalizeBoolean("1"), true);
});

test("normalizeBoolean: falsy string tokens", () => {
  assert.equal(normalizeBoolean("false"), false);
  assert.equal(normalizeBoolean("no"), false);
  assert.equal(normalizeBoolean("0"), false);
  assert.equal(normalizeBoolean("random"), false);
});

test("normalizeBoolean: null/undefined/non-string → false", () => {
  assert.equal(normalizeBoolean(null), false);
  assert.equal(normalizeBoolean(undefined), false);
  assert.equal(normalizeBoolean(42), false);
  assert.equal(normalizeBoolean({}), false);
});

// ── normalizeCount ──────────────────────────────────────────────────────────

test("normalizeCount: valid non-negative integers", () => {
  assert.equal(normalizeCount(0), 0);
  assert.equal(normalizeCount(5), 5);
  assert.equal(normalizeCount("10"), 10);
});

test("normalizeCount: negative → fallback", () => {
  assert.equal(normalizeCount(-1), 0);
  assert.equal(normalizeCount(-1, 99), 99);
});

test("normalizeCount: NaN/null/undefined → fallback", () => {
  assert.equal(normalizeCount(NaN), 0);
  assert.equal(normalizeCount(null), 0);
  assert.equal(normalizeCount(undefined), 0);
  assert.equal(normalizeCount("abc"), 0);
});

test("normalizeCount: Infinity → fallback", () => {
  assert.equal(normalizeCount(Infinity), 0);
  assert.equal(normalizeCount(-Infinity), 0);
});

test("normalizeCount: float strings truncated to integer", () => {
  assert.equal(normalizeCount("3.9"), 3);
});

// ── normalizePositiveInteger ────────────────────────────────────────────────

test("normalizePositiveInteger: valid positive integers", () => {
  assert.equal(normalizePositiveInteger(1), 1);
  assert.equal(normalizePositiveInteger(100), 100);
  assert.equal(normalizePositiveInteger("42"), 42);
});

test("normalizePositiveInteger: zero → fallback (not positive)", () => {
  assert.equal(normalizePositiveInteger(0), 0);
  assert.equal(normalizePositiveInteger(0, 5), 5);
});

test("normalizePositiveInteger: negative → fallback", () => {
  assert.equal(normalizePositiveInteger(-3), 0);
  assert.equal(normalizePositiveInteger(-3, 10), 10);
});

test("normalizePositiveInteger: NaN/null/undefined → fallback", () => {
  assert.equal(normalizePositiveInteger(NaN), 0);
  assert.equal(normalizePositiveInteger(null), 0);
  assert.equal(normalizePositiveInteger(undefined), 0);
  assert.equal(normalizePositiveInteger("xyz"), 0);
});

test("normalizePositiveInteger: Infinity → fallback", () => {
  assert.equal(normalizePositiveInteger(Infinity), 0);
});

// ── normalizeFiniteNumber ───────────────────────────────────────────────────

test("normalizeFiniteNumber: finite numbers pass through", () => {
  assert.equal(normalizeFiniteNumber(3.14), 3.14);
  assert.equal(normalizeFiniteNumber(0), 0);
  assert.equal(normalizeFiniteNumber(-7), -7);
});

test("normalizeFiniteNumber: numeric strings parsed", () => {
  assert.equal(normalizeFiniteNumber("2.5"), 2.5);
  assert.equal(normalizeFiniteNumber("-10"), -10);
});

test("normalizeFiniteNumber: Infinity → fallback", () => {
  assert.equal(normalizeFiniteNumber(Infinity), null);
  assert.equal(normalizeFiniteNumber(-Infinity), null);
  assert.equal(normalizeFiniteNumber(Infinity, 0), 0);
});

test("normalizeFiniteNumber: NaN → fallback", () => {
  assert.equal(normalizeFiniteNumber(NaN), null);
  assert.equal(normalizeFiniteNumber(NaN, -1), -1);
});

test("normalizeFiniteNumber: null/undefined/non-numeric → fallback", () => {
  assert.equal(normalizeFiniteNumber(null), null);
  assert.equal(normalizeFiniteNumber(undefined), null);
  assert.equal(normalizeFiniteNumber("abc"), null);
  assert.equal(normalizeFiniteNumber({}), null);
});

// ── uniqueStrings ───────────────────────────────────────────────────────────

test("uniqueStrings: deduplicates and trims", () => {
  assert.deepEqual(uniqueStrings(["a", "  a  ", "b", "b"]), ["a", "b"]);
});

test("uniqueStrings: filters out non-string / empty values", () => {
  assert.deepEqual(uniqueStrings(["x", null, "", undefined, 42, "y"]), ["x", "y"]);
});

test("uniqueStrings: non-array input → empty array", () => {
  assert.deepEqual(uniqueStrings(null), []);
  assert.deepEqual(uniqueStrings(undefined), []);
  assert.deepEqual(uniqueStrings("string"), []);
  assert.deepEqual(uniqueStrings(42), []);
});

test("uniqueStrings: preserves order of first occurrence", () => {
  assert.deepEqual(uniqueStrings(["c", "a", "b", "a", "c"]), ["c", "a", "b"]);
});

// ── uniqueTools ─────────────────────────────────────────────────────────────

test("uniqueTools: lowercases and deduplicates", () => {
  assert.deepEqual(uniqueTools(["Read", "read", "Write"]), ["read", "write"]);
});

test("uniqueTools: applies aliases (websearch → web_search)", () => {
  assert.deepEqual(uniqueTools(["websearch", "webfetch"]), ["web_search", "web_fetch"]);
});

test("uniqueTools: alias dedup with canonical name", () => {
  assert.deepEqual(uniqueTools(["web_search", "websearch"]), ["web_search"]);
});

test("uniqueTools: filters out null/empty values", () => {
  assert.deepEqual(uniqueTools(["read", null, "", undefined, "write"]), ["read", "write"]);
});

test("uniqueTools: non-array input → empty array", () => {
  assert.deepEqual(uniqueTools(null), []);
  assert.deepEqual(uniqueTools(undefined), []);
  assert.deepEqual(uniqueTools(42), []);
});

// ── normalizeEnum ───────────────────────────────────────────────────────────

test("normalizeEnum: valid member returns lowercase", () => {
  const valid = new Set(["alpha", "beta", "gamma"]);
  assert.equal(normalizeEnum("Alpha", valid), "alpha");
  assert.equal(normalizeEnum("BETA", valid), "beta");
});

test("normalizeEnum: invalid member → fallback", () => {
  const valid = new Set(["alpha", "beta"]);
  assert.equal(normalizeEnum("delta", valid), null);
  assert.equal(normalizeEnum("delta", valid, "alpha"), "alpha");
});

test("normalizeEnum: null/undefined/non-string → fallback", () => {
  const valid = new Set(["alpha"]);
  assert.equal(normalizeEnum(null, valid), null);
  assert.equal(normalizeEnum(undefined, valid), null);
  assert.equal(normalizeEnum(42, valid), null);
  assert.equal(normalizeEnum("", valid), null);
});

// ── getErrorMessage ─────────────────────────────────────────────────────────

test("getErrorMessage: extracts message from Error", () => {
  assert.equal(getErrorMessage(new Error("boom")), "boom");
});

test("getErrorMessage: converts string directly", () => {
  assert.equal(getErrorMessage("something failed"), "something failed");
});

test("getErrorMessage: null/undefined → 'unknown'", () => {
  assert.equal(getErrorMessage(null), "unknown");
  assert.equal(getErrorMessage(undefined), "unknown");
  assert.equal(getErrorMessage(""), "unknown");
});

test("getErrorMessage: number/object stringified", () => {
  assert.equal(getErrorMessage(404), "404");
  assert.equal(getErrorMessage({ code: 1 }), "[object Object]");
});

// ── compactText ─────────────────────────────────────────────────────────────

test("compactText: short text returned as-is (trimmed)", () => {
  assert.equal(compactText("  hello  "), "hello");
});

test("compactText: text at maxLength not truncated", () => {
  const exact = "a".repeat(180);
  assert.equal(compactText(exact), exact);
});

test("compactText: text exceeding maxLength truncated with ellipsis", () => {
  const long = "a".repeat(200);
  const result = compactText(long);
  assert.equal(result.length, 180);
  assert.ok(result.endsWith("..."));
});

test("compactText: custom maxLength", () => {
  const result = compactText("abcdefghij", 7);
  assert.equal(result, "abcd...");
  assert.equal(result.length, 7);
});

test("compactText: null/undefined/empty → null", () => {
  assert.equal(compactText(null), null);
  assert.equal(compactText(undefined), null);
  assert.equal(compactText(""), null);
  assert.equal(compactText("   "), null);
});
