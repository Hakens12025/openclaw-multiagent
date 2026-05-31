/**
 * TDD: admin-change-set-executor.js
 *
 * Bug 1 (line 65-66): dry-run 调两次 Date.now()，durationMs 偏差。
 * Bug 2 (line 83+95): 内层 const result 遮盖外层 const result。
 *
 * 这两处 bug 都在 executeAdminChangeSet 内部，与文件系统、gateway 紧耦合，
 * 无法写纯单元测试。此处验证代码层面修复：
 *  - 通过静态检查源码确认 dryRun 分支只调一次 Date.now()
 *  - 通过静态检查确认内层不再重复声明 const result
 *
 * 静态检查方法：读取源码字符串做断言。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(
  join(__dirname, "../lib/admin/admin-change-set-executor.js"),
  "utf8",
);

// 提取 dryRun 分支代码块（从 "if (dryRun)" 到对应 closing "}"）
// 简单方案：抓取 dryRun 块内容
function extractDryRunBlock(src) {
  const start = src.indexOf("if (dryRun) {");
  if (start === -1) return null;
  let depth = 0;
  let i = start;
  let blockStart = -1;
  while (i < src.length) {
    if (src[i] === "{") {
      if (blockStart === -1) blockStart = i;
      depth++;
    } else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
    i++;
  }
  return null;
}

test("dryRun 分支内 Date.now() 只应调用一次", () => {
  const block = extractDryRunBlock(source);
  assert.ok(block, "未找到 dryRun 分支");
  const matches = block.match(/Date\.now\(\)/g) || [];
  assert.equal(
    matches.length,
    1,
    `dryRun 分支中 Date.now() 出现 ${matches.length} 次，应恰好为 1 次（先取 finishedAt 再复用）`,
  );
});

test("外层 try 中不应存在两个 'const result' 声明（遮盖检测）", () => {
  // 找到 executeAdminChangeSet 函数体
  const fnStart = source.indexOf("export async function executeAdminChangeSet(");
  assert.ok(fnStart !== -1, "未找到 executeAdminChangeSet 函数");
  const fnBody = source.slice(fnStart);

  // 计算所有 "const result" 的出现次数
  const allConstResult = (fnBody.match(/\bconst result\b/g) || []).length;
  assert.equal(
    allConstResult,
    1,
    `executeAdminChangeSet 中 "const result" 出现 ${allConstResult} 次，应恰好为 1 次（内层改为 verificationResult）`,
  );
});
