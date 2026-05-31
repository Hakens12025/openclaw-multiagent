#!/usr/bin/env node

import {
  loadConfig,
  SSEClient,
} from "../lib/formal-runtime/infra.js";
import {
  DIRECT_SERVICE_CASES,
  runDirectServiceCreateTaskProbe,
} from "../lib/formal-runtime/suite-direct-service.js";

await loadConfig();
const sse = new SSEClient();
await sse.connect();

const result = await runDirectServiceCreateTaskProbe(DIRECT_SERVICE_CASES[0], sse);
console.log(JSON.stringify(result, null, 2));

sse.close();

if (!result.pass) {
  process.exitCode = 1;
}
