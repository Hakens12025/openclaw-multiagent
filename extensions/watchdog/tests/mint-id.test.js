import test from "node:test";
import assert from "node:assert/strict";

import { mintId, mintContractId } from "../lib/core/mint-id.js";
import { sha256Hex } from "../lib/core/sha256-hex.js";

// ID 形状是盘上真值的一部分(合约文件名/票据 id/trace 文件名),
// 这些正则即收编前四个铸造点的原始形状,任何漂移都会让盘上数据失联。
const LEGACY_SHAPES = {
  TC: /^TC-\d+-[0-9a-f]{6}$/,
  SADT: /^SADT-\d+-[0-9a-f]{6}$/,
  DIRECT: /^DIRECT-\d+-[0-9a-f]{6}$/,
};

test("mintId preserves the legacy shape for every enrolled prefix", () => {
  for (const [prefix, shape] of Object.entries(LEGACY_SHAPES)) {
    const id = mintId(prefix);
    assert.match(id, shape, `${prefix} id "${id}" must keep the on-disk shape`);
  }
});

test("mintId honors injected now and nonce verbatim", () => {
  assert.equal(mintId("DIRECT", { now: 1780315176649, nonce: "a9c81a" }), "DIRECT-1780315176649-a9c81a");
  assert.equal(mintId("TC", { now: 42 }).startsWith("TC-42-"), true);
});

test("mintId defaults produce a current timestamp and unique nonces", () => {
  const before = Date.now();
  const ids = new Set();
  for (let i = 0; i < 200; i += 1) ids.add(mintId("TC", { now: before }));
  assert.equal(ids.size, 200, "200 mints with a fixed now must stay unique via nonce");
  const ts = Number(mintId("TC").split("-")[1]);
  assert.equal(ts >= before && ts <= Date.now(), true);
});

test("mintContractId is the single TC- minting point and matches the twins' shape", () => {
  assert.match(mintContractId(), LEGACY_SHAPES.TC);
  assert.equal(mintContractId(1780315176649).startsWith("TC-1780315176649-"), true);
});

test("sha256Hex matches known vectors and coerces empty-ish input like the legacy wrappers", () => {
  assert.equal(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  const emptyDigest = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
  assert.equal(sha256Hex(""), emptyDigest);
  // 旧 wrapper 是 String(text || "") — null/undefined 与空串同 digest,收编保持一致
  assert.equal(sha256Hex(null), emptyDigest);
  assert.equal(sha256Hex(undefined), emptyDigest);
});
