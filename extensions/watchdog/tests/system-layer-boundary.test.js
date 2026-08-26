// 三系统边界的可执行形态(备忘录134)。
//
// 系统1 生产拥有「意图与计划」,系统3 判决拥有「判据与结论」。判决是外挂:它判、
// 它记、它拦,但生产侧不依赖它——所以依赖方向必须单向(判决 → 生产),这是
// 「判决可拔除」唯一能被机器验证的含义。
//
// 两张表**只登记已裁定的模块**,不是全库分类。新模块归属定了再进表;表小而真
// 胜过大而猜——一张 371 行的分类表会把「分系统」做成「分目录」。
import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCAN_ROOTS = ["lib", "hooks"];

// 判决侧(2026-08-10 重做后):判决 = 系统级机械核对甲方期望,零 LLM,全部内容就
// lib/judgment/ 一个目录。旧的判定器群(考官三件、contract-outcome 287 行五路优先级、
// stage-witness-engine 323 行证人引擎、交接门)已整体删除。
// terminal-outcome.js 是执行面的收口(按事实关合约),它消费判决的报告,但自己不判质量。
const JUDGMENT_SIDE = [
  "lib/judgment/",
  "lib/contract/contract-expectations.js",
];

// 判决内部件:只有判决侧自己能引用。单文件判决面没有内部件——
// expectation-check.js 本身就是判决对执行面的唯一公开边(报"缺什么"),
// 收口(terminal-outcome)消费它是三分结构里唯一合法的 ②→③ 引用。
const JUDGMENT_INTERNAL = [];

// 生产侧的意图与计划模块:计划是「打算分几步」,与「实际走到哪了」无关。
const PRODUCTION_INTENT = [
  "lib/stage/task-stage-plan.js",
  "lib/stage/task-stage-planner.js",
  "lib/stage/stage-marker-parser.js",
  "lib/prompt/",
];

const IMPORT_SPECIFIER = /\bfrom\s+"(\.[^"]*)"|\bimport\s+"(\.[^"]*)"/g;

function matchesAny(file, entries) {
  return entries.some((entry) => (entry.endsWith("/") ? file.startsWith(entry) : file === entry));
}

async function listSourceFiles() {
  const files = [];
  for (const scanRoot of SCAN_ROOTS) {
    const entries = await readdir(join(ROOT, scanRoot), { recursive: true, withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".js")) continue;
      files.push(relative(ROOT, join(entry.parentPath || entry.path, entry.name)));
    }
  }
  files.push("index.js");
  return files;
}

// 只解析相对说明符——裸包与 node: 内置不参与分层。
async function collectImportEdges() {
  const edges = [];
  for (const file of await listSourceFiles()) {
    const source = await readFile(join(ROOT, file), "utf8");
    for (const match of source.matchAll(IMPORT_SPECIFIER)) {
      const specifier = match[1] || match[2];
      edges.push({
        from: file,
        to: relative(ROOT, resolve(dirname(join(ROOT, file)), specifier)),
      });
    }
  }
  return edges;
}

test("production intent modules never import the judgment side", async () => {
  const edges = await collectImportEdges();
  const violations = edges
    .filter((edge) => matchesAny(edge.from, PRODUCTION_INTENT) && matchesAny(edge.to, JUDGMENT_SIDE))
    .map((edge) => `${edge.from} -> ${edge.to}`);

  assert.deepEqual(
    violations,
    [],
    "计划模块引用了判决模块。计划归系统1,判决归系统3,依赖只能是判决 → 生产;"
    + "若确有需要,先在备忘录134 改归属裁定,再改本表。",
  );
});

test("judgment internals are reachable only from the judgment side", async () => {
  const edges = await collectImportEdges();
  const violations = edges
    .filter((edge) => matchesAny(edge.to, JUDGMENT_INTERNAL) && !matchesAny(edge.from, JUDGMENT_SIDE))
    .map((edge) => `${edge.from} -> ${edge.to}`);

  assert.deepEqual(
    violations,
    [],
    "判决内部件被判决侧之外的模块直接引用。对外请走判决的公开面"
    + "(阶段判决 = lib/stage/task-stage-truth.js,终态 = lib/contract/terminal-outcome.js)。",
  );
});

test("the boundary tables name modules that exist", async () => {
  const files = new Set(await listSourceFiles());
  const declared = [...JUDGMENT_SIDE, ...JUDGMENT_INTERNAL, ...PRODUCTION_INTENT];
  const missing = declared.filter((entry) => !entry.endsWith("/") && !files.has(entry));

  assert.deepEqual(missing, [], "边界表里有幽灵条目——模块已改名或删除,表未同步");
});
