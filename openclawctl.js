#!/usr/bin/env node
// openclawctl — OpenClaw 多 Agent 系统的跨平台运维入口(产品化批1,2026-08-28)。
// 取代 bash 层(setup.sh/start.sh/clean-restart-gateway.sh):运行时是 Node,
// 运维工具就全部 Node——macOS/Linux 原生一等,Windows 经 WSL2。
// 服务单元由宿主 `openclaw gateway install` 按平台生成(launchd/systemd/schtasks)。
//
// 用法:
//   node openclawctl.js init [--with-qqbot]   初始化(配置生成+token 签发+目录骨架)
//   node openclawctl.js doctor                环境体检
//   node openclawctl.js start                 启动网关(预检→env→install→start→等就绪)
//   node openclawctl.js stop                  停止网关(端口双证,绝不模糊 pkill)
//   node openclawctl.js restart               重启(唯一正道,取代 clean-restart-gateway.sh)
//   node openclawctl.js status                运行状态与前端地址
//   node openclawctl.js logs [--errors] [--lines N]

import {
  cmdInit, cmdDoctor, cmdStart, cmdStop, cmdRestart, cmdStatus, cmdLogs,
} from "./scripts/ctl/ctl-commands.js";

const [, , command, ...rest] = process.argv;
const has = (flag) => rest.includes(flag);
const numOf = (flag, fallback) => {
  const i = rest.indexOf(flag);
  const n = i > -1 ? Number(rest[i + 1]) : NaN;
  return Number.isInteger(n) && n > 0 ? n : fallback;
};

const COMMANDS = {
  init: () => cmdInit({ withQqbot: has("--with-qqbot") }),
  doctor: () => cmdDoctor(),
  start: () => cmdStart(),
  stop: () => cmdStop(),
  restart: () => cmdRestart(),
  status: () => cmdStatus(),
  logs: () => cmdLogs({ lines: numOf("--lines", 40), errors: has("--errors") }),
};

const run = COMMANDS[command];
if (!run) {
  console.log("openclawctl — OpenClaw 跨平台运维入口");
  console.log("命令: init | doctor | start | stop | restart | status | logs");
  console.log("详见文件头注释或 SETUP.md。");
  process.exit(command ? 1 : 0);
}

run().then(
  (code) => process.exit(code ?? 0),
  (error) => {
    console.error(`✗ openclawctl ${command} 异常: ${error?.message || error}`);
    process.exit(1);
  },
);
