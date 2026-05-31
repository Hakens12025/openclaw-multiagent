// SSEClient for formal-runtime infrastructure

import http from "node:http";
import { BASE, tokens } from "./infra-tokens.js";

export class SSEClient {
  constructor() {
    this.events = [];
    this.listeners = [];
    this.req = null;
    this.connected = false;
    this.connectedAt = 0;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const url = new URL(`${BASE}/watchdog/stream?token=${tokens.gateway}`);
      this.req = http.get({
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        headers: { "Accept": "text/event-stream" },
      }, (res) => {
        let buf = "";
        res.on("data", (chunk) => {
          buf += chunk.toString();
          const parts = buf.split("\n\n");
          buf = parts.pop();
          for (const part of parts) {
            const eventLine = part.match(/^event:\s*(.+)$/m);
            const dataLine = part.match(/^data:\s*(.+)$/m);
            if (!eventLine || !dataLine) continue;
            const eventType = eventLine[1].trim();
            let data;
            try { data = JSON.parse(dataLine[1]); } catch { data = dataLine[1]; }
            const replay = !this.connected;
            const evt = { type: eventType, data, receivedAt: Date.now(), replay };
            this.events.push(evt);
            if (eventType === "connected") {
              this.connected = true;
              this.connectedAt = Date.now();
              resolve();
            }
            if (!replay) {
              for (let i = this.listeners.length - 1; i >= 0; i--) {
                const l = this.listeners[i];
                if (!evt.claimed && l.filter(evt)) {
                  evt.claimed = true;
                  clearTimeout(l.timer);
                  this.listeners.splice(i, 1);
                  l.resolve(evt);
                }
              }
            }
          }
        });
        res.on("error", reject);
      });
      this.req.on("error", reject);
    });
  }

  waitFor(filter, timeoutMs) {
    const existing = this.events.find(e => !e.replay && !e.claimed && filter(e));
    if (existing) {
      existing.claimed = true;
      return Promise.resolve(existing);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const idx = this.listeners.findIndex(l => l.timer === timer);
        if (idx >= 0) this.listeners.splice(idx, 1);
        resolve(null);
      }, timeoutMs);
      this.listeners.push({ filter, resolve, timer });
    });
  }

  resetBaseline() {
    for (const evt of this.events) evt.claimed = true;
  }

  close() {
    for (const l of this.listeners) clearTimeout(l.timer);
    this.listeners = [];
    if (this.req) {
      try { this.req.destroy(); } catch {}
    }
  }
}
