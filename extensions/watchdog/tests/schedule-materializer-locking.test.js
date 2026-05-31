import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  removeScheduleMaterialization,
  SCHEDULE_MATERIALIZER_STORE,
  syncScheduleMaterialization,
} from "../lib/schedule/schedule-materializer.js";

function buildScheduleSpec(id, expr) {
  return {
    id,
    enabled: true,
    trigger: {
      type: "cron",
      expr,
      tz: "Asia/Shanghai",
    },
    entry: {
      targetAgent: "controller",
      message: `run ${id}`,
    },
  };
}

function buildFakeApi() {
  return {
    runtime: {
      system: {
        async runCommandWithTimeout(argv) {
          const nameIndex = argv.indexOf("--name");
          const jobName = nameIndex >= 0 ? argv[nameIndex + 1] : "unknown";
          const scheduleId = jobName.replace(/^watchdog schedule:\s*/u, "").trim() || "unknown";
          return {
            code: 0,
            stdout: JSON.stringify({
              id: `job:${scheduleId}`,
              removed: true,
            }),
            stderr: "",
          };
        },
      },
    },
  };
}

test("concurrent schedule materialization syncs do not lose sibling writes", async () => {
  const base = `schedule-materializer-lock-${Date.now()}`;
  const idA = `${base}-a`;
  const idB = `${base}-b`;
  const api = buildFakeApi();

  try {
    await Promise.allSettled([
      removeScheduleMaterialization(idA, { api }),
      removeScheduleMaterialization(idB, { api }),
    ]);

    await Promise.all([
      syncScheduleMaterialization(buildScheduleSpec(idA, "*/5 * * * *"), { api }),
      syncScheduleMaterialization(buildScheduleSpec(idB, "*/10 * * * *"), { api }),
    ]);

    const raw = JSON.parse(await readFile(SCHEDULE_MATERIALIZER_STORE, "utf8"));
    const entries = Array.isArray(raw?.entries) ? raw.entries : [];
    assert.equal(entries.some((entry) => entry.scheduleId === idA), true);
    assert.equal(entries.some((entry) => entry.scheduleId === idB), true);
  } finally {
    await Promise.allSettled([
      removeScheduleMaterialization(idA, { api }),
      removeScheduleMaterialization(idB, { api }),
    ]);
  }
});
