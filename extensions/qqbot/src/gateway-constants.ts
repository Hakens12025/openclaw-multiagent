/**
 * QQ Bot Gateway 常量
 * 纯常量，无副作用
 */
import path from "node:path";

// ============ QQ Bot intents - 按权限级别分组 ============
export const INTENTS = {
  // 基础权限（默认有）
  GUILDS: 1 << 0,                    // 频道相关
  GUILD_MEMBERS: 1 << 1,             // 频道成员
  PUBLIC_GUILD_MESSAGES: 1 << 30,    // 频道公开消息（公域）
  // 需要申请的权限
  DIRECT_MESSAGE: 1 << 12,           // 频道私信
  GROUP_AND_C2C: 1 << 25,            // 群聊和 C2C 私聊（需申请）
};

// 权限级别：从高到低依次尝试
export const INTENT_LEVELS = [
  // Level 0: 完整权限（群聊 + 私信 + 频道）
  {
    name: "full",
    intents: INTENTS.PUBLIC_GUILD_MESSAGES | INTENTS.DIRECT_MESSAGE | INTENTS.GROUP_AND_C2C,
    description: "群聊+私信+频道",
  },
  // Level 1: 群聊 + 频道（无私信）
  {
    name: "group+channel",
    intents: INTENTS.PUBLIC_GUILD_MESSAGES | INTENTS.GROUP_AND_C2C,
    description: "群聊+频道",
  },
  // Level 2: 仅频道（基础权限）
  {
    name: "channel-only",
    intents: INTENTS.PUBLIC_GUILD_MESSAGES | INTENTS.GUILD_MEMBERS,
    description: "仅频道消息",
  },
];

// ============ 重连配置 ============
export const RECONNECT_DELAYS = [1000, 2000, 5000, 10000, 30000, 60000]; // 递增延迟
export const RATE_LIMIT_DELAY = 60000; // 遇到频率限制时等待 60 秒
export const MAX_RECONNECT_ATTEMPTS = 100;
export const MAX_QUICK_DISCONNECT_COUNT = 3; // 连续快速断开次数阈值
export const QUICK_DISCONNECT_THRESHOLD = 5000; // 5秒内断开视为快速断开

// ============ 图床服务器配置 ============
// 可通过环境变量覆盖
export const IMAGE_SERVER_PORT = parseInt(process.env.QQBOT_IMAGE_SERVER_PORT || "18765", 10);
// 使用绝对路径，确保文件保存和读取使用同一目录
export const IMAGE_SERVER_DIR = process.env.QQBOT_IMAGE_SERVER_DIR || path.join(process.env.HOME || "/home/ubuntu", "clawd", "qqbot-images");

// ============ 消息队列配置 ============
// 异步处理，防止阻塞心跳
export const MESSAGE_QUEUE_SIZE = 1000; // 最大队列长度
export const MESSAGE_QUEUE_WARN_THRESHOLD = 800; // 队列告警阈值
