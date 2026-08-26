import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { resolveOperatorBrainModel } from "../lib/llm/brain-model-resolver.js";

function buildConfig(provider) {
  return {
    agents: {
      defaults: {
        model: {
          primary: "test-provider/model-a",
        },
      },
    },
    models: {
      providers: {
        "test-provider": {
          api: "openai-completions",
          baseUrl: "http://model.example/v1",
          models: [{ id: "model-a" }],
          ...provider,
        },
      },
    },
  };
}

test("operator brain model resolves provider apiKey from schema-compatible env reference", () => {
  const previous = process.env.OPENCLAW_TEST_PROVIDER_KEY;
  process.env.OPENCLAW_TEST_PROVIDER_KEY = "env-secret";
  try {
    const model = resolveOperatorBrainModel(buildConfig({
      apiKey: "env:OPENCLAW_TEST_PROVIDER_KEY",
    }));

    assert.equal(model.apiKey, "env-secret");
  } finally {
    if (previous === undefined) delete process.env.OPENCLAW_TEST_PROVIDER_KEY;
    else process.env.OPENCLAW_TEST_PROVIDER_KEY = previous;
  }
});

test("operator brain model resolves provider apiKey from schema-compatible file reference", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openclaw-provider-key-"));
  try {
    const keyPath = join(dir, "provider.key");
    await writeFile(keyPath, "file-secret\n", "utf8");
    const model = resolveOperatorBrainModel(buildConfig({
      apiKey: `file:${keyPath}`,
    }));

    assert.equal(model.apiKey, "file-secret");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
