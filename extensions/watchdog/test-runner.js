#!/usr/bin/env node

// test-runner.js — CLI client for watchdog formal test surface
//
// This file is intentionally thin. It must not re-implement case execution,
// routing observation, or report assembly. Those belong to the formal surface
// behind /watchdog/test-runs/*.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { request as httpRequest } from "node:http";
import { pathToFileURL } from "node:url";
import {
  findCliPreset,
  resolveCliRunExitCode,
  waitForCliRunCompletion,
} from "./lib/test-runner-cli-client.js";

const OC = join(homedir(), ".openclaw");
const CONFIG_FILE = join(OC, "openclaw.json");
const PORT = 18789;
const BASE = `http://localhost:${PORT}`;

let gatewayToken = "";

async function loadConfig() {
  const raw = await readFile(CONFIG_FILE, "utf8");
  const cfg = JSON.parse(raw);
  gatewayToken = cfg.gateway?.auth?.token ?? "";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function httpFetch(url, {
  method = "GET",
  headers = {},
  body = null,
  timeout = 15000,
} = {}) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const opts = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port,
      path: parsedUrl.pathname + parsedUrl.search,
      method,
      headers: { ...headers },
    };
    if (body) {
      opts.headers["Content-Type"] = "application/json";
    }
    const req = httpRequest(opts, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("error", reject);
    req.setTimeout(timeout, () => req.destroy(new Error("timeout")));
    if (body) req.write(body);
    req.end();
  });
}

function buildAuthedPath(path) {
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}token=${gatewayToken}`;
}

async function requestJSON(path, options = {}) {
  const { body } = await httpFetch(`${BASE}${buildAuthedPath(path)}`, options);
  return JSON.parse(body);
}

async function fetchPresetSurface() {
  return requestJSON("/watchdog/test-runs");
}

async function startFormalRun(presetId) {
  return requestJSON("/watchdog/test-runs/start", {
    method: "POST",
    body: JSON.stringify({ presetId }),
    timeout: 30000,
  });
}

function printProgress(detail) {
  const status = detail?.status || "unknown";
  const currentCaseId = detail?.currentCaseId || "--";
  const passedCases = detail?.passedCases || 0;
  const failedCases = detail?.failedCases || 0;
  const blockedCases = detail?.blockedCases || 0;
  console.log(`[${status}] case=${currentCaseId} pass=${passedCases} fail=${failedCases} blocked=${blockedCases}`);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const presetFlag = args.indexOf("--preset");
  return {
    presetId: presetFlag >= 0 ? args[presetFlag + 1] : "single",
  };
}

export async function main(argv = process.argv) {
  const { presetId } = parseArgs(argv);

  await loadConfig();

  try {
    const runtime = await requestJSON("/watchdog/runtime");
    console.log("OpenClaw Test Runner");
    console.log(`Gateway online. Active sessions: ${Object.keys(runtime.trackingSessions || {}).length}, SSE clients: ${runtime.sseClientCount}`);
  } catch (error) {
    console.error(`FATAL: Gateway not reachable at localhost:${PORT}: ${error.message}`);
    return 1;
  }

  const presetSurface = await fetchPresetSurface();
  const preset = findCliPreset(presetSurface, presetId);
  if (!preset) {
    const available = (presetSurface?.presets || []).map((entry) => entry.id).join(", ");
    console.error(`Unknown preset: ${presetId}. Available: ${available}`);
    return 1;
  }

  console.log(`Preset: ${preset.id} (${preset.label})`);
  console.log(`Suite: ${preset.suite}`);
  console.log(`Description: ${preset.description || "--"}`);

  const startResult = await startFormalRun(preset.id);
  if (startResult?.ok !== true || !startResult?.run?.id) {
    console.error(`FATAL: failed to start preset ${preset.id}: ${startResult?.error || "unknown error"}`);
    return 1;
  }

  console.log(`Run: ${startResult.run.id}`);

  const detail = await waitForCliRunCompletion({
    runId: startResult.run.id,
    requestJSON,
    sleep,
    onProgress: printProgress,
  });

  if (detail?.reportText) {
    console.log(`\n${detail.reportText}`);
  } else {
    console.log("\n(no report text returned)");
  }

  if (detail?.reportFile) {
    console.log(`\nReport saved: ${detail.reportFile}`);
  }
  if (detail?.rawReportFile) {
    console.log(`Raw report: ${detail.rawReportFile}`);
  }

  return resolveCliRunExitCode(detail);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((exitCode) => {
    process.exit(exitCode);
  }).catch((error) => {
    console.error(`FATAL: ${error.message}`);
    console.error(error.stack);
    process.exit(2);
  });
}
