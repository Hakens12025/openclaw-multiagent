// lib/core/kernel-lease.js — kernel 租约单例锚（与 boot-ledger.js 同款模式）。
// 本插件一切进程内副作用的属主;各 lib 模块直接 import 本模块取租约,
// 不经 index.js(防装配图求值与循环依赖)。
import { createLeaseHolder } from "./lease.js";

export const kernelLease = createLeaseHolder("watchdog-kernel");
