import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const packageJson = JSON.parse(
  readFileSync(resolve(process.cwd(), "package.json"), "utf8"),
) as { type?: string };

describe("runtime module mode", () => {
  it("marks the project as ESM so TypeScript scripts avoid typeless-package warnings", () => {
    expect(packageJson.type).toBe("module");
  });
});

describe("shared state configuration", () => {
  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("defaults to the in-memory backend with a durable file path available", async () => {
    vi.stubEnv("STATE_BACKEND", undefined);
    vi.stubEnv("STATE_STORE_PATH", undefined);
    vi.resetModules();

    const { config } = await import("@/lib/config");

    expect(config.stateBackend).toBe("memory");
    expect(config.stateStorePath).toBe(".data/voxen-state.json");
  });

  it("accepts the file backend override", async () => {
    vi.stubEnv("STATE_BACKEND", "file");
    vi.stubEnv("STATE_STORE_PATH", ".data/shared.json");
    vi.resetModules();

    const { config } = await import("@/lib/config");

    expect(config.stateBackend).toBe("file");
    expect(config.stateStorePath).toBe(".data/shared.json");
  });

  it("uses safe local defaults for the Redis backend", async () => {
    for (const name of [
      "STATE_BACKEND",
      "REDIS_URL",
      "REDIS_STATE_KEY",
      "REDIS_LOCK_TTL_MS",
      "REDIS_LOCK_TIMEOUT_MS",
    ]) {
      vi.stubEnv(name, undefined);
    }
    vi.resetModules();

    const { config } = await import("@/lib/config");

    expect(config.stateBackend).toBe("memory");
    expect(config.redisUrl).toBe("redis://127.0.0.1:6379");
    expect(config.redisStateKey).toBe("voxen:state");
    expect(config.redisLockTtlMs).toBe(10_000);
    expect(config.redisLockTimeoutMs).toBe(5_000);
  });

  it("accepts explicit Redis connection, key and lock settings", async () => {
    vi.stubEnv("STATE_BACKEND", "redis");
    vi.stubEnv("REDIS_URL", "redis://cache.internal:6380/2");
    vi.stubEnv("REDIS_STATE_KEY", "tenant:voxen");
    vi.stubEnv("REDIS_LOCK_TTL_MS", "4000");
    vi.stubEnv("REDIS_LOCK_TIMEOUT_MS", "2000");
    vi.resetModules();

    const { config } = await import("@/lib/config");

    expect(config.stateBackend).toBe("redis");
    expect(config.redisUrl).toBe("redis://cache.internal:6380/2");
    expect(config.redisStateKey).toBe("tenant:voxen");
    expect(config.redisLockTtlMs).toBe(4_000);
    expect(config.redisLockTimeoutMs).toBe(2_000);
  });
});

describe("eval trace configuration", () => {
  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("keeps live trace recording disabled by default", async () => {
    vi.stubEnv("EVAL_TRACE_ENABLED", undefined);
    vi.stubEnv("EVAL_TRACE_PATH", undefined);
    vi.resetModules();

    const { config } = await import("@/lib/config");

    expect(config.evalTraceEnabled).toBe(false);
    expect(config.evalTracePath).toBe(".data/eval-traces.jsonl");
  });

  it("accepts an explicit isolated recording path", async () => {
    vi.stubEnv("EVAL_TRACE_ENABLED", "true");
    vi.stubEnv("EVAL_TRACE_PATH", ".data/live-evals.jsonl");
    vi.resetModules();

    const { config } = await import("@/lib/config");

    expect(config.evalTraceEnabled).toBe(true);
    expect(config.evalTracePath).toBe(".data/live-evals.jsonl");
  });
});

describe("workflow TTL configuration", () => {
  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("uses safe defaults when TTL overrides are absent", async () => {
    vi.stubEnv("SHARE_TTL_MS", undefined);
    vi.stubEnv("CONFIRMATION_TTL_MS", undefined);
    vi.resetModules();

    const { config } = await import("@/lib/config");

    expect(config.shareTtlMs).toBe(24 * 60 * 60 * 1000);
    expect(config.confirmationTtlMs).toBe(10 * 60 * 1000);
  });

  it("accepts explicit TTL overrides", async () => {
    vi.stubEnv("SHARE_TTL_MS", "60000");
    vi.stubEnv("CONFIRMATION_TTL_MS", "30000");
    vi.resetModules();

    const { config } = await import("@/lib/config");

    expect(config.shareTtlMs).toBe(60_000);
    expect(config.confirmationTtlMs).toBe(30_000);
  });
});
