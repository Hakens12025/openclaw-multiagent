import test from "node:test";
import assert from "node:assert/strict";

import {
  exportStructureCode,
  decodeStructureCode,
  estimateCodeSize,
  scanForSecrets,
  collectLiveSecretValues,
  SHARE_LEVELS,
} from "../lib/control-plane/structure-share-code.js";

test("L1 structure code: exports, decodes, integrity, no secrets/content", async () => {
  const res = await exportStructureCode({ level: SHARE_LEVELS.STRUCTURE });
  assert.equal(res.ok, true, `L1 export must succeed (got ${JSON.stringify(res.error || res.hits)})`);
  assert.match(res.code, /^OCS-v1-S-[0-9a-f]{8}-/);
  assert.equal(res.shareable, true);
  assert.equal(res.containsSecrets, false);

  const dec = decodeStructureCode(res.code);
  assert.equal(dec.ok, true);
  assert.equal(dec.level, "S");
  assert.equal(dec.integrityOk, true, "hash must verify after decode");
  assert.ok(dec.payload.graph && Array.isArray(dec.payload.agents), "structure present");
  assert.equal(dec.payload.content, undefined, "L1 must NOT carry agent content");
  assert.equal(dec.payload.fullConfig, undefined, "L1 must NOT carry full config");
});

test("L2 content code: embeds prose, references builtin skills by name, no full config", async () => {
  const res = await exportStructureCode({ level: SHARE_LEVELS.CONTENT });
  assert.equal(res.ok, true, `L2 export must succeed (got ${JSON.stringify(res.error || res.hits)})`);
  assert.match(res.code, /^OCS-v1-SC-/);

  const dec = decodeStructureCode(res.code);
  assert.equal(dec.ok, true);
  assert.equal(dec.level, "SC");
  assert.ok(dec.payload.content, "L2 has content");
  assert.ok(dec.payload.content.prose && typeof dec.payload.content.prose === "object", "prose embedded");
  assert.ok(Array.isArray(dec.payload.content.builtinSkills), "builtin skills referenced by name");
  assert.equal(dec.payload.fullConfig, undefined, "L2 must NOT carry full config/secrets");
});

test("L3 full code: contains full config, flagged containsSecrets + NOT shareable", async () => {
  const res = await exportStructureCode({ level: SHARE_LEVELS.FULL });
  assert.equal(res.ok, true);
  assert.match(res.code, /^OCS-v1-SCA-/);
  assert.equal(res.containsSecrets, true);
  assert.equal(res.shareable, false, "L3 must never be flagged shareable");
  const dec = decodeStructureCode(res.code);
  assert.ok(dec.payload.fullConfig, "L3 carries full config for personal reproduction");
});

test("secret scanner flags live secret values + generic key patterns", () => {
  const live = collectLiveSecretValues({ gateway: { auth: { token: "supersecrettoken1234" } }, nested: { apiKey: "abcd1234efgh5678ij" } });
  assert.ok(live.has("supersecrettoken1234"));
  assert.ok(live.has("abcd1234efgh5678ij"));

  // a payload that leaked a live secret value → flagged
  assert.ok(scanForSecrets('{"soul":"... token=supersecrettoken1234 ..."}', live).length > 0);
  // a clean payload → no hits
  assert.equal(scanForSecrets('{"edges":[{"from":"a","to":"b"}]}', live).length, 0);
  // generic pattern backstop
  assert.ok(scanForSecrets('{"x":"sk-ABCDEFGHIJKLMNOP1234567890"}', new Set()).length > 0);
});

test("decode rejects garbage + non-OCS strings without throwing", () => {
  assert.equal(decodeStructureCode("not-a-code").ok, false);
  assert.equal(decodeStructureCode("OCS-v1-S-deadbeef-@@@notbase64@@@").ok, false);
  assert.equal(decodeStructureCode("").ok, false);
});

test("estimateCodeSize reports size + compression ratio for L1", async () => {
  const est = await estimateCodeSize({ level: SHARE_LEVELS.STRUCTURE });
  assert.equal(est.ok, true);
  assert.ok(est.sizeBytes > 0);
  assert.ok(est.compressionRatio >= 1, "brotli should not inflate");
});
