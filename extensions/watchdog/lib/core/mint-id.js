// mint-id.js — 运行时 ID 单一铸造点(OMIT-07 单源红线)。
// 形状 `<PREFIX>-<ms>-<6hex>` 是盘上真值的一部分(合约文件名/票据 id),
// 收编只做同形状换实现;格式变更等同于让既有盘上数据失联。

import { randomBytes } from "node:crypto";

export function mintId(prefix, { now = Date.now(), nonce = randomBytes(3).toString("hex") } = {}) {
  return `${prefix}-${now}-${nonce}`;
}

// TC- 原有两个双胞胎铸造点(ingress 入口 + loop 回合),此处并为唯一来源。
export function mintContractId(now = Date.now()) {
  return mintId("TC", { now });
}
