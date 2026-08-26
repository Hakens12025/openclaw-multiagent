// legacy-archive-purge.js — boot 一次性断代清扫两个旧平铺档案店。
//
// 约束:会话归档与 inbox/产出快照的正本落 run 树 participants/(写者见
// run-tree-archive.js / run-tree-snapshot.js),下列旧目录不得再有任何写者,
// 每次 boot 整目录删除:
//   control-plane/session-archive/   (旧 <agent>/{<sid>.jsonl,<sid>.prompt.json,index.json})
//   control-plane/workflow-trace/    (旧 <cid>/{<agent>/inbox/,output.md})
// 清扫失败只告警不阻断 boot(旧店是死店,残留无害,下次 boot 再清)。

import { rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { CONTROL_PLANE_PATHS } from "../control-plane/control-plane-paths.js";

// 死店名单是封闭集:除这两个目录外,本清扫器对任何路径零触碰(rootDir 注入仅为
// 破坏性路径的可测性,生产恒 CONTROL_PLANE_PATHS.root)。
const LEGACY_ARCHIVE_DIRNAMES = ["session-archive", "workflow-trace"];

export async function purgeLegacyArchiveStores({ logger = null, rootDir = CONTROL_PLANE_PATHS.root } = {}) {
  let purged = 0;
  for (const dir of LEGACY_ARCHIVE_DIRNAMES.map((name) => join(rootDir, name))) {
    if (!existsSync(dir)) continue;
    try {
      await rm(dir, { recursive: true, force: true });
      purged += 1;
      logger?.info?.(`[legacy-archive-purge] removed legacy store: ${dir}`);
    } catch (error) {
      logger?.warn?.(`[legacy-archive-purge] failed to remove ${dir}: ${error?.message || error}`);
    }
  }
  return { purged };
}
