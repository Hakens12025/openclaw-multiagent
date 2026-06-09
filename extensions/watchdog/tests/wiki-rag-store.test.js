import test from "node:test";
import assert from "node:assert/strict";

import {
  buildWikiRagIndex,
  loadWikiRagIndex,
  searchWikiRag,
} from "../lib/operator/wiki-rag-store.js";
import { searchWiki } from "../lib/operator/wiki-rag-search.js";
import { embedText } from "../lib/operator/wiki-rag-embed.js";

// These tests exercise the real wiki/ corpus + the local ollama embeddings.
// When ollama is down the build degrades (ok:true, degraded:true) and we assert
// the degraded contract instead of skipping silently.
let ollamaUp = false;
try {
  await embedText("probe", {});
  ollamaUp = true;
} catch {
  ollamaUp = false;
}

test("buildWikiRagIndex builds over wiki/ with chunks (or degrades cleanly)", async () => {
  const result = await buildWikiRagIndex({ force: true });
  assert.equal(result.ok, true, "build must always return ok:true");
  if (!ollamaUp) {
    assert.equal(result.degraded, true, "ollama down → degraded:true");
    assert.equal(result.reembedded, 0, "degraded build re-embeds nothing");
    return;
  }
  assert.ok(result.chunkCount > 0, `expected chunkCount>0, got ${result.chunkCount}`);
  assert.ok(result.reembedded > 0, "forced build should re-embed");
});

test("second build with no wiki change re-embeds nothing (incremental reuse)", async (t) => {
  if (!ollamaUp) return t.skip("ollama unavailable");
  await buildWikiRagIndex({ force: true });
  const second = await buildWikiRagIndex({});
  assert.equal(second.ok, true);
  assert.equal(second.reembedded, 0, `incremental build re-embedded ${second.reembedded}, expected 0`);
  assert.ok(second.reused > 0, "unchanged chunks should be reused");
});

test("loaded index records carry vector + sourcePath + hash", async (t) => {
  if (!ollamaUp) return t.skip("ollama unavailable");
  const index = await loadWikiRagIndex();
  assert.ok(Array.isArray(index.chunks) && index.chunks.length > 0);
  const sample = index.chunks[0];
  assert.equal(typeof sample.sourcePath, "string");
  assert.equal(typeof sample.hash, "string");
  assert.ok(Array.isArray(sample.vector) && sample.vector.length > 0);
});

test("searchWiki('operator 控制面 designer') surfaces operator wiki chunk", async (t) => {
  if (!ollamaUp) return t.skip("ollama unavailable");
  await buildWikiRagIndex({ force: true });
  const out = await searchWiki("operator 控制面 designer", { topK: 5 });
  assert.equal(out.ok, true);
  assert.ok(out.results.length > 0, "expected results");
  const hasOperator = out.results.some((r) => String(r.sourcePath || "").includes("operator"));
  assert.ok(hasOperator, `expected an operator sourcePath in top-5, got: ${out.results.map((r) => r.sourcePath).join(", ")}`);
});

test("searchWikiRag ranks by cosine descending", async (t) => {
  if (!ollamaUp) return t.skip("ollama unavailable");
  const index = await loadWikiRagIndex();
  const q = await embedText("loop conveyor belt dispatch", {});
  const ranked = await searchWikiRag(q, { topK: 3, index });
  assert.ok(ranked.length > 0);
  for (let i = 1; i < ranked.length; i += 1) {
    assert.ok(ranked[i - 1].score >= ranked[i].score, "scores must be non-increasing");
  }
});
