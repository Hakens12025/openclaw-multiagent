#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import process from "node:process";

import {
  buildSystemBlockReport,
  parseGitStatusPath,
  SYSTEM_BLOCKS,
} from "../extensions/watchdog/lib/dev/system-block-registry.js";

const args = process.argv.slice(2);

if (args.includes("--list")) {
  for (const block of SYSTEM_BLOCKS) {
    const support = block.support ? "support" : "core";
    console.log(`${block.id}\t${support}\t${block.purpose}`);
  }
  process.exit(0);
}

const primaryBlock = readOption(args, "--primary") || readOption(args, "--block");
if (!primaryBlock) {
  console.error("missing required option: --primary <system-block>");
  console.error("run with --list to see available blocks");
  process.exit(2);
}

const cwd = process.cwd();
const changedFiles = git(["status", "--short", "--untracked-files=all"], cwd)
  .split("\n")
  .map(parseGitStatusPath)
  .filter(Boolean);
const report = buildSystemBlockReport({ primaryBlock, files: changedFiles });

console.log(`primary block: ${report.primaryBlock}`);

if (report.summary) {
  const blockNames = Object.keys(report.summary.byBlock).sort();
  if (blockNames.length > 0) {
    console.log("changed files by block:");
    for (const blockId of blockNames) {
      console.log(`  ${blockId}: ${report.summary.byBlock[blockId].length}`);
    }
  }
  if (report.summary.unclassified.length > 0) {
    console.log(`unclassified files: ${report.summary.unclassified.length}`);
    for (const file of report.summary.unclassified) {
      console.log(`  ${file}`);
    }
  }
}

if (!report.ok) {
  console.error("system block check failed:");
  for (const problem of report.problems) {
    console.error(`  ${problem}`);
  }
  process.exit(1);
}

console.log("system block check passed");

function readOption(args, option) {
  const index = args.indexOf(option);
  if (index === -1) {
    return null;
  }
  return args[index + 1] || null;
}

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}
