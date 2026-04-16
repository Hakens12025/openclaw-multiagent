---
name: qqbot-repair
description: QQBot 连接修复技能。当 QQBot 连接出现问题（IP白名单错误、WebSocket被拒、SSH隧道断开等）时，AI 可自动诊断并修复。
metadata: {"clawdbot":{"emoji":"🔧"}}
---

# QQBot 连接修复

诊断并修复 QQBot 与 OpenClaw 之间的连接问题，核心是 SSH 隧道 + HTTP 代理链路。

---

## 架构说明

```
本机 openclaw
    │
    ├─ HTTP/HTTPS 请求 → HTTPS_PROXY=localhost:8080
    │      └─ SSH -L 8080 → 云服务器:8080
    │              └─ http-proxy.py → QQ API（出口 IP = 云服务器 YOUR_REMOTE_HOST）
    │
    ├─ WebSocket → HttpsProxyAgent → localhost:8080（同上）
    │
    └─ QQ 平台回调 → SSH -R 18791 → 本机:18789（openclaw gateway）
```

云服务器 IP：`YOUR_REMOTE_HOST`

---

## AI 决策指南

### 症状识别与处置

| 症状 | 原因 | 处置 |
|------|------|------|
| `接口访问源IP不在白名单` / `40023002` | HTTP 请求没走代理 | 检查并重启 SSH 隧道 |
| `4924 session ip forbidden` | WebSocket 没走代理 | 同上，修复代理链路 |
| `remote port forwarding failed for listen port 18791` | 云服务器 18791 端口被僵尸进程占用 | 杀死云服务器上的僵尸进程 |
| qqbot 不回复消息（无错误） | bindings 配置错误 | 检查 openclaw.json bindings |
| 本地 8080 无监听 | SSH 隧道未启动或已断开 | 重启隧道 |

### 诊断顺序

1. 先检查 SSH 隧道进程
2. 检查本地 8080 端口
3. 检查云服务器代理
4. 验证代理链路（curl 测试）
5. 如有需要，清理僵尸进程后重启

---

## 诊断命令

### 第一步：检查 SSH 隧道进程

```bash
ps aux | grep ssh-tunnel | grep -v grep
```

有输出 = 隧道在跑；无输出 = 隧道未启动。

### 第二步：检查本地 8080 端口

```bash
lsof -i :8080 | grep LISTEN
```

有监听 = 隧道正常转发；无监听 = 隧道有问题。

### 第三步：检查云服务器代理服务

```bash
ssh root@YOUR_REMOTE_HOST "systemctl status http-proxy"
```

### 第四步：验证完整代理链路

```bash
curl -x http://127.0.0.1:8080 https://api.sgroup.qq.com/gateway \
  -H "Authorization: QQBot test" -H "Content-Type: application/json"
```

返回 `token not exist` = 代理正常（IP 已通过白名单）；返回 IP 白名单错误 = 代理未生效。

### 检查 bindings 配置

```bash
cat ~/.openclaw/openclaw.json | python3 -m json.tool | grep -A5 bindings
```

应看到 `qqbot` → `agent-for-kksl` 的绑定。

---

## 修复命令

### 修复：重启 SSH 隧道

```bash
# 清理现有进程
pkill -f ssh-tunnel.sh
pkill -f 'ssh.*18791.*YOUR_REMOTE_HOST'

# 重启隧道
bash ~/.openclaw/ssh-tunnel.sh >> /tmp/openclaw-ssh-tunnel.log 2>&1 &
echo "隧道 PID: $!"
```

### 修复：清理云服务器僵尸进程（端口 18791 被占用时）

```bash
# 查找占用进程
ssh root@YOUR_REMOTE_HOST "ss -tlnp | grep 18791"

# 杀死占用进程
ssh root@YOUR_REMOTE_HOST "kill \$(ss -tlnp | grep 18791 | grep -oP 'pid=\K[0-9]+')"
```

### 修复：重启云服务器代理

```bash
ssh root@YOUR_REMOTE_HOST "systemctl restart http-proxy"
```

### 修复：完整重启流程

```bash
# 1. 清理本地隧道
pkill -f ssh-tunnel.sh
pkill -f 'ssh.*18791.*YOUR_REMOTE_HOST'

# 2. 清理云服务器僵尸进程
ssh root@YOUR_REMOTE_HOST "kill \$(ss -tlnp | grep 18791 | grep -oP 'pid=\K[0-9]+') 2>/dev/null; echo done"

# 3. 重启云服务器代理（如需要）
ssh root@YOUR_REMOTE_HOST "systemctl restart http-proxy"

# 4. 重启本地隧道
sleep 2
bash ~/.openclaw/ssh-tunnel.sh >> /tmp/openclaw-ssh-tunnel.log 2>&1 &

# 5. 等待隧道建立
sleep 3

# 6. 验证
lsof -i :8080 | grep LISTEN && echo "隧道正常" || echo "隧道异常"
```

---

## 关键配置文件

| 文件 | 说明 |
|------|------|
| `~/.openclaw/ssh-tunnel.sh` | SSH 隧道脚本（含 -R 18791 和 -L 8080） |
| `~/.zshrc` | openclaw 启动函数，注入 HTTPS_PROXY |
| `~/.openclaw/openclaw.json` | 主配置（bindings: qqbot → agent-for-kksl） |
| `~/.openclaw/extensions/qqbot/src/api.ts` | HTTP 请求代理（undici ProxyAgent） |
| `~/.openclaw/extensions/qqbot/src/gateway.ts` | WebSocket 代理（HttpsProxyAgent） |

---

## 正常启动方式

```bash
# 终端启动
openclaw gateway run

# 或双击桌面文件
~/Desktop/启动OpenClaw.command
```

两种方式都会自动启动 SSH 隧道并注入 HTTPS_PROXY。

---

## 用户交互模板

### 开始诊断

```
正在诊断 QQBot 连接问题，先检查 SSH 隧道状态...
```

### 发现隧道未运行

```
SSH 隧道没有运行，正在重启...
```

### 发现僵尸进程

```
云服务器端口 18791 被占用，正在清理僵尸进程后重启隧道...
```

### 修复成功

```
已修复。代理链路验证通过（QQ API 返回正常响应），QQBot 应该可以正常使用了。

如果还有问题，可以尝试完整重启：
openclaw gateway run
```

### 修复失败（需要用户介入）

```
自动修复未能解决问题，请检查：
1. 云服务器 YOUR_REMOTE_HOST 是否可以 SSH 访问
2. ~/.openclaw/ssh-tunnel.sh 脚本是否存在
3. 查看隧道日志：cat /tmp/openclaw-ssh-tunnel.log
```
