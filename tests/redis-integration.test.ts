import { createClient } from "redis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createRedisStateBackend } from "@/lib/state";

/**
 * Opt-in smoke test against a real Redis server. Set REDIS_INTEGRATION=1 and
 * REDIS_URL to enable it; CI provides a Redis service. The default unit suite
 * stays hermetic and skips this file.
 */
const enabled = process.env.REDIS_INTEGRATION === "1";
const url = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
const key = `voxen:test:${process.pid}`;

describe.skipIf(!enabled)("Redis state integration", () => {
  let admin: ReturnType<typeof createClient>;

  beforeAll(async () => {
    admin = createClient({ url });
    await admin.connect();
    await admin.del([key, `${key}:lock`]);
  });

  afterAll(async () => {
    if (admin?.isOpen) {
      await admin.del([key, `${key}:lock`]);
      await admin.quit();
    }
  });

  function backend() {
    return createRedisStateBackend({
      url,
      key,
      lockTtlMs: 5_000,
      lockTimeoutMs: 2_000,
    });
  }

  it("shares and serializes state across two live clients", async () => {
    const first = backend();
    const second = backend();

    try {
      await Promise.all([
        first.write(async (document) => {
          document.counters["integration"] = (document.counters["integration"] ?? 0) + 1;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }),
        second.write(async (document) => {
          document.counters["integration"] = (document.counters["integration"] ?? 0) + 1;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }),
      ]);

      expect(await first.read((document) => document.counters["integration"])).toBe(2);
      expect(await admin.exists([key, `${key}:lock`])).toBe(1);
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  });

  it("fails closed on an invalid document until an operator clears the key", async () => {
    const state = backend();
    try {
      await admin.set(key, "{not json");
      await expect(state.read((document) => document.budget)).rejects.toThrow(
        "not valid JSON",
      );
      await expect(state.write(() => undefined)).rejects.toThrow(
        "not valid JSON",
      );

      // Fail-closed means no silent fallback; recovery is an explicit action.
      await admin.del([key]);
      await state.reset();
      expect(await state.read((document) => document.budget.date)).toBe("");
    } finally {
      await state.close();
    }
  });
});
