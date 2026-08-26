import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

// ui-i18n-hygiene — 硬编码中文 lint 守卫。
// 规则：ui/** 下 JS 字符串字面量 / HTML 文本与属性中零 CJK；键表文件豁免。
// 用迷你词法器扫 JS（字符串态收集内容，注释态跳过），避免注释里的中文误报
// 以及 "http://..." 类字符串被注释剥离器切碎。

const CJK = /[぀-ヿ㐀-䶿一-鿿豈-﫿]/u;
const EXEMPT = new Set(["i18n-keys.js"]);

function scanJsStrings(source) {
  const hits = [];
  let i = 0;
  let mode = "code";
  let buf = "";
  let line = 1;
  const n = source.length;
  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === "\n") line += 1;
    if (mode === "code") {
      if (ch === "/" && next === "/") { mode = "lineComment"; i += 2; continue; }
      if (ch === "/" && next === "*") { mode = "blockComment"; i += 2; continue; }
      if (ch === "'" || ch === '"' || ch === "`") { mode = ch; buf = ""; i += 1; continue; }
      i += 1;
      continue;
    }
    if (mode === "lineComment") {
      if (ch === "\n") mode = "code";
      i += 1;
      continue;
    }
    if (mode === "blockComment") {
      if (ch === "*" && next === "/") { mode = "code"; i += 2; continue; }
      i += 1;
      continue;
    }
    // 字符串态（mode 为引号字符）
    if (ch === "\\") { buf += ch + (next ?? ""); i += 2; continue; }
    if (ch === mode) {
      if (CJK.test(buf)) hits.push({ line, text: buf.slice(0, 40) });
      mode = "code";
      i += 1;
      continue;
    }
    buf += ch;
    i += 1;
  }
  return hits;
}

function scanHtml(source) {
  const noComments = source.replace(/<!--[\s\S]*?-->/g, "");
  return CJK.test(noComments) ? [{ line: 0, text: "(html)" }] : [];
}

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(path));
    else out.push(path);
  }
  return out;
}

test("i18n hygiene: 词法器能抓出字符串字面量里的中文", () => {
  const dirty = "const a = \"加载中\"; // 注释里的中文不算\nconst b = 'x';\nconst c = `好的 ${n}`;";
  const hits = scanJsStrings(dirty);
  assert.equal(hits.length, 2);
  assert.equal(hits[0].line, 1);
});

test("i18n hygiene: ui/** 零硬编码中文（键表豁免）", async () => {
  const uiDir = new URL("../ui/", import.meta.url).pathname;
  const files = (await walk(uiDir)).filter((f) => /\.(js|html)$/.test(f) && !EXEMPT.has(f.split("/").pop()));
  assert.ok(files.length > 0, "应扫到 ui 源码文件");
  const violations = [];
  for (const file of files) {
    const source = await readFile(file, "utf8");
    const hits = file.endsWith(".html") ? scanHtml(source) : scanJsStrings(source);
    for (const hit of hits) violations.push(`${file}:${hit.line} ${hit.text}`);
  }
  assert.deepEqual(violations, [], "UI 文案必须走 i18n 键表");
});
