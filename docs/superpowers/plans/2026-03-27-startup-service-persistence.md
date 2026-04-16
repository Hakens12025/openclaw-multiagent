# Startup Service Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `start.sh` leave OpenClaw startup services alive after the shell exits by moving background startup off `nohup/&` and onto persistent service management.

**Architecture:** Reuse OpenClaw's built-in gateway LaunchAgent workflow for the gateway, add a dedicated `launchctl`-managed LaunchAgent for the SSH tunnel, and lock the desired behavior with a shell regression script that proves `start.sh` returns while gateway health still works.

**Tech Stack:** Bash, launchd/launchctl, OpenClaw CLI service management, shell verification.

---

### Task 1: Lock The Regression With A Red Test

**Files:**
- Create: `/Users/hakens/.openclaw/scripts/test-start-service-persistence.sh`
- Test: `/Users/hakens/.openclaw/scripts/test-start-service-persistence.sh`

- [ ] Add a shell regression script that:
  - stops any existing gateway service and tunnel service,
  - runs `/Users/hakens/.openclaw/start.sh`,
  - waits briefly after script exit,
  - requires `openclaw health --json --timeout 5000` to succeed,
  - requires `lsof -nP -iTCP:18789 -sTCP:LISTEN` to show a listener.
- [ ] Run the script before implementation and confirm it fails because the background-started gateway is gone after `start.sh` exits.

### Task 2: Move Gateway Startup To Built-In Service Management

**Files:**
- Modify: `/Users/hakens/.openclaw/start.sh`

- [ ] Replace manual `nohup openclaw gateway run ... &` startup with `openclaw gateway install --force --port ...` plus `openclaw gateway start`.
- [ ] Replace direct PID-based readiness checks with service/RPC readiness checks that survive shell exit.
- [ ] Keep the CA bundle refresh before service install/start so the generated LaunchAgent inherits the corrected trust configuration.

### Task 3: Add LaunchAgent Management For SSH Tunnel

**Files:**
- Create: `/Users/hakens/.openclaw/scripts/ssh-tunnel-service.sh`
- Modify: `/Users/hakens/.openclaw/start.sh`
- Test: `/Users/hakens/.openclaw/scripts/test-start-service-persistence.sh`

- [ ] Add a helper that writes/loads `~/Library/LaunchAgents/ai.openclaw.ssh-tunnel.plist` with the current profile values and starts it via `launchctl`.
- [ ] Update `start.sh` to use that helper instead of `bash ssh-tunnel.sh ... &`.
- [ ] Keep the tunnel readiness probe on `OPENCLAW_PROXY_PORT`.

### Task 4: Verify Cross-Command Persistence

**Files:**
- Test: `/Users/hakens/.openclaw/scripts/test-start-service-persistence.sh`

- [ ] Re-run `/Users/hakens/.openclaw/scripts/test-start-service-persistence.sh` and confirm green.
- [ ] Run `openclaw health --json --timeout 5000` in a fresh command and confirm it succeeds.
- [ ] Run `openclaw agent --agent researcher --session-id gw-persist-20260327 --thinking minimal --message '只回复 OK' --json --timeout 30000` and confirm gateway path succeeds.
