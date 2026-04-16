# OpenClaw Multi-Agent System - Setup Guide

This repository contains the complete configuration for a multi-agent collaboration system built on OpenClaw. Follow this guide to reproduce the entire setup on a new machine.

## System Architecture

```
User --> controller (WebUI) --+
                              +--> ingress / create_task --> planner
User --> agent-for-kksl ------+                               |
         (QQ Bot)                                            v
                         ~/.openclaw/workspaces/controller/contracts/TC-xxx.json
                                                        |
                                                Watchdog dispatch
                                                        |
                                                 worker / worker2
                                                        |
                                                 execute task, write output
                                                        |
                                                        v
                        ~/.openclaw/workspaces/controller/output/TC-xxx.md
                                                        |
                                      delivery:terminal --> controller / kksl
                                                        |
                                                        v
                                                 User receives result
```

### Agent Roles

| Agent | ID | Role | Tools | Model |
|-------|----|------|-------|-------|
| WebUI Gateway | `controller` | WebUI ingress + final delivery | controlled tool surface | MiniMax M2.5 |
| QQ Gateway | `agent-for-kksl` | QQ ingress + final delivery | deny exec-style tools | MiniMax M2.5 |
| Planner | `planner` | Stage planning + one-shot dispatch planning | constrained planning role | DeepSeek V3.2 |
| Executor | `worker`, `worker2` | Receives execution contracts and produces artifacts | execution tools | DeepSeek V3.2 |
| Extra Planner Capacity | `plan1`, `plan2` | Reserved planner lanes for later expansion | planner role | DeepSeek V3.2 |

### Providers

| Provider | Base URL | Models | Role |
|----------|----------|--------|------|
| dashscope (Alibaba) | `https://coding.dashscope.aliyuncs.com/v1` | MiniMax M2.5, GLM-5, Kimi K2.5 | **Primary** |
| cherry-nvidia | `https://integrate.api.nvidia.com/v1` | MiniMax M2.5, Qwen 3.5 | Backup |
| ollama | `http://localhost:11434/v1` | Qwen 3 8B | Local fallback |

---

## Prerequisites

- **macOS** (tested on Darwin 25.1.0, Mac mini)
- **Node.js v25+** (via nvm)
- **Git**
- **GitHub CLI** (`gh`) - for pushing to remote
- **SSH access** to cloud server `YOUR_REMOTE_HOST` (for QQ Bot tunnel)

---

## Step-by-Step Setup

### 1. Install OpenClaw

```bash
# Install nvm if not already installed
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.0/install.sh | bash

# Install and use Node.js v25
nvm install 25
nvm use 25

# Install OpenClaw globally
npm install -g openclaw

# Verify installation
openclaw --version
```

### 2. Clone This Repository

```bash
cd ~
git clone https://github.com/Hakens12025/openclaw-config.git .openclaw
cd ~/.openclaw
```

### 3. Run Initial Configuration

```bash
openclaw configure
```

This creates the base structure. Our cloned config files will override the defaults.

### 4. Create Workspace Directories

```bash
# Create canonical runtime workspaces only
mkdir -p ~/.openclaw/workspaces/controller/contracts
mkdir -p ~/.openclaw/workspaces/controller/output
mkdir -p ~/.openclaw/workspaces/controller/deliveries
mkdir -p ~/.openclaw/workspaces/planner
mkdir -p ~/.openclaw/workspaces/worker
mkdir -p ~/.openclaw/workspaces/worker2
mkdir -p ~/.openclaw/workspaces/kksl
mkdir -p ~/.openclaw/workspaces/plan1
mkdir -p ~/.openclaw/workspaces/plan2
```

### 5. Keep `workspaces/` As The Only Canonical Runtime Tree

Fresh installs should not create `workspace-*` directories. If you still have any legacy alias, remove it and keep only `workspaces/*` as runtime truth.

```bash
# Remove old alias residue if it still exists
rm -f ~/.openclaw/workspace-planner ~/.openclaw/workspace-worker ~/.openclaw/workspace-worker2
```

### 6. Install QQ Bot Plugin Dependencies

```bash
cd ~/.openclaw/extensions/qqbot
npm install
npm run build
cd ~/.openclaw
```

### 7. Update API Keys (if needed)

Edit `~/.openclaw/openclaw.json` and update:

1. **dashscope API key**: `models.providers.dashscope.apiKey`
2. **NVIDIA API key**: `models.providers.cherry-nvidia.apiKey`
3. **QQ Bot credentials**: `channels.qqbot.appId` and `channels.qqbot.clientSecret`
4. **Gateway auth token**: `gateway.auth.token`

### 8. Setup SSH Tunnel (for QQ Bot)

The QQ Bot requires a reverse SSH tunnel to a cloud server for receiving callbacks.

```bash
# Make tunnel script executable
chmod +x ~/.openclaw/ssh-tunnel.sh

# Test tunnel manually
~/.openclaw/ssh-tunnel.sh
```

The tunnel establishes:
- `-R 18791:localhost:18789` (reverse tunnel: cloud -> local gateway)
- `-L 8080:localhost:8080` (forward tunnel: local -> cloud HTTP proxy)

Cloud server: `YOUR_REMOTE_HOST`

**Note:** `openclaw gateway run` automatically manages the tunnel lifecycle.

### 9. Start the Gateway

```bash
node ~/.openclaw/scripts/ensure-openclaw-agent-schema-compat.mjs
openclaw config validate
cd ~/.openclaw
openclaw gateway run
```

Or run in background:
```bash
bash ~/.openclaw/start.sh
```

`start.sh` now runs the same preflight automatically:

- patch bundled OpenClaw `AgentEntrySchema` copies so watchdog agent metadata keys are accepted
- run `openclaw config validate` before gateway startup
- wait for a real listener on `:18789` and fail fast if the gateway exits during startup

The gateway starts on port **18789**.

### 10. Verify

1. **WebUI**: Open `http://localhost:18789` in browser
2. **Watchdog Dashboard**: `http://localhost:18789/watchdog/progress?token=<your-token>`
3. **Runtime Endpoint**: `http://localhost:18789/watchdog/runtime`

Test the full chain:
1. Send a message via WebUI (e.g., "write a poem about spring")
2. Gateway should route the request into the planner / execution chain
3. Planner should write contract state into `workspaces/controller/contracts/`
4. Watchdog should dispatch to `worker` or `worker2`
5. Executor should write output and delivery artifacts
6. Result is delivered back to user

---

## File Structure

```
~/.openclaw/
├── openclaw.json                        # Main config (agents, providers, tools, plugins)
├── openclaw.json.bak-nvidia-20260308    # NVIDIA config backup
├── .gitignore                           # Git ignore rules
│
├── extensions/
│   ├── watchdog/
│   │   ├── index.js                     # Watchdog plugin (931 lines)
│   │   └── openclaw.plugin.json         # Plugin manifest
│   └── qqbot/
│       ├── index.ts                     # QQ Bot plugin entry point
│       ├── openclaw.plugin.json         # Plugin manifest
│       ├── package.json                 # Node dependencies
│       ├── tsconfig.json                # TypeScript config
│       └── src/                         # QQ Bot source code
│
├── workspaces/
│   ├── controller/
│   │   ├── contracts/                   # Shared contract snapshots
│   │   ├── output/                      # Canonical final output paths
│   │   └── deliveries/                  # delivery:terminal payloads
│   ├── planner/                         # Planner workspace
│   ├── worker/                          # Executor workspace
│   ├── worker2/                         # Executor workspace
│   ├── kksl/                            # QQ gateway workspace
│   ├── plan1/                           # Reserved planner lane
│   └── plan2/                           # Reserved planner lane
│
├── scripts/                             # Helper scripts
│
├── ssh-tunnel.sh                        # SSH tunnel script for QQ Bot
│
└── use guide/                           # Documentation
    ├── README.md                        # Guide index
    ├── multi-agent-implementation-plan.md
    ├── openclaw-models-setup-guide.md
    ├── qqbot-ssh-proxy-guide.md
    └── 系统通信备忘录4.md                # Architecture doc (v4, verified working)
```

---

## Key Mechanisms

### Task Contract Lifecycle

```
Planner / runtime writes contract snapshot --> pending
Watchdog before_agent_start --> running
Worker executes task
Watchdog agent_end --> completed / failed
Watchdog deliverResult --> Delivery JSON --> heartbeat callback
```

### Watchdog Plugin (Industrial-Grade)

- **Hook 1** (`before_agent_start`): Create tracking entry + bind pending Contract + set running
- **Hook 2** (`after_tool_call`): Semantic labels + progress estimation + SSE broadcast + Contract write detection + auto-dispatch
- **Hook 3** (`agent_end`): Complete/fail marking + Contract status update + Delivery creation + QQ push + crash recovery
- **Dispatch chain**: `dispatchChain` Map tracks `sessions_send` call chains, 5-min TTL
- **replyTo injection**: Automatically injects `replyTo` field in Contracts pointing to original Gateway
- **SSE Dashboard**: `/watchdog/progress` (requires token)
- **Runtime JSON**: `/watchdog/runtime`

### Planner Boundaries

- `planner` is the planning node; it should not become an implicit executor
- Canonical runtime paths live under `workspaces/*`
- Legacy `workspace-*` directories are migration residue only; do not treat them as source of truth
- Use `openclaw.json` agent bindings as the authority for live workspace selection

### Communication Flow

| Method | Purpose | From | To |
|--------|---------|------|----|
| Ingress / task creation | Receive user intent and start runtime chain | Gateway | Planner / runtime |
| Execution Contract | Structured task dispatch | Planner / runtime | Worker / Worker2 |
| `delivery:system_action.*` | Return subtask results to initiating agent | Worker / runtime | Planner / Worker |
| `delivery:terminal` | Return final result to user-facing gateway | Runtime | Controller / agent-for-kksl |
| Heartbeat | Periodic wakeup + crash recovery | System/Watchdog | All Agents |

---

## Known Limitations

1. **MiniMax M2.5 parameter truncation**: Multi-parameter tool calls may drop parameters (~50%). Simple one-shot flows are usually fine; long or deeply nested tasks may fail.
2. **Long task API timeout**: Complex research tasks may timeout. Increase `timeoutSeconds` or split into steps.
3. **USR1 reload instability**: `kill -USR1` triggers drain timeout with active tasks. Use `pkill -9 -f openclaw` then restart.
4. **Qwen 3.5 instruction following**: Sometimes ignores SOUL.md and answers directly instead of creating Contract.

---

## Troubleshooting

### Gateway won't start
```bash
# Check if another instance is running
pgrep -f openclaw
# Kill all instances
pkill -9 -f openclaw
# Restart
openclaw gateway run
```

### Planner not writing contract state
- Check `~/.openclaw/workspaces/controller/contracts/` for contract snapshots
- Verify `planner` is configured in `openclaw.json`
- Make sure no old `workspace-*` alias is shadowing the planner workspace

### Worker not picking up tasks
- Check `~/.openclaw/workspaces/worker/inbox/contract.json`
- Check `~/.openclaw/workspaces/worker2/inbox/contract.json`
- Verify worker heartbeat is configured: `"every": "30m"`
- Check Watchdog is enabled in plugins config

### QQ Bot not connecting
- Verify SSH tunnel is running: `ps aux | grep ssh-tunnel`
- Check cloud server is reachable: `ssh root@YOUR_REMOTE_HOST`
- Verify QQ credentials in `channels.qqbot`

### Config reload (without restart)
```bash
# Only reloads config, NOT plugin code
pgrep -f "openclaw-gateway" | xargs kill -USR1
# WARNING: May cause drain timeout if tasks are active
```
