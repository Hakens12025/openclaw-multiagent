// sha256-hex.js — 证据层 sha256 单一导出(OMIT-07 单源红线)。
// 放 core 而非 evidence:store/knowledge/control-plane 各层后续收编时
// 从 core 引入无层级倒挂;String(text || "") 的空值坍缩与旧 wrapper 一致,
// 既有 trace 文件名(含 hash 片段)依赖该行为。

import { createHash } from "node:crypto";

export function sha256Hex(text) {
  return createHash("sha256").update(String(text || "")).digest("hex");
}
