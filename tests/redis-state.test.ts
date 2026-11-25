import { beforeEach, describe, expect, it } from "vitest";

import {
  createRedisStateBackend,
  RELEASE_LOCK_SCRIPT,
  type RedisStateClient,
  type RedisSetOptions,
} from "@/lib/state";

/** Minimal Redis semantics needed by the state adapter, entirely in memory. */
class FakeRedisClient implements RedisStateClient {
  readonly values = new Map<string, string>();
  private readonly expiries = new Map<string, number>();

  private expires(key: string): void {
    const deadline = this.expiries.get(key);
    if (deadline !== undefined && deadline <= Date.now()) {
      this.values.delete(key);
      this.expiries.delete(key);
    }
  }

  private raw(key: string): string | null {
    this.expires(key);
    return this.values.get(key) ?? null;
  }

  async get(key: string): Promise<string | null> {
    return this.raw(key);
  }

  async set(
    key: string,
    value: string,
    options?: RedisSetOptions,
  ): Promise<string | null> {
    this.expires(key);
    if (options?.nx && this.values.has(key)) return null;
    this.values.set(key, value);
    if (options?.px) this.expiries.set(key, Date.now() + options.px);
    else this.expiries.delete(key);
    return "OK";
  }

  async eval(script: string, keys: string[], args: string[]): Promise<unknown> {
    if (script !== RELEASE_LOCK_SCRIPT) {
      throw new Error("Unexpected Lua script.");
    }
    const key = keys[0];
    if (key !== undefined && this.raw(key) === args[0]) {
      this.values.delete(key);
      this.expiries.delete(key);
      return 1;
    }
    return 0;
  }
}

describe("Redis state backend", () => {
  let client: FakeRedisClient;

  beforeEach(() => {
    client = new FakeRedisClient();
  });

  function backend(overrides: { key?: string; lockTimeoutMs?: number } = {}) {
    return createRedisStateBackend({
      client,
      key: overrides.key ?? "voxen:state",
      lockTimeoutMs: overrides.lockTimeoutMs ?? 200,
    });
  }

  it("round-trips nested documents through read and write", async () => {
    const state = backend();
    await state.write((document) => {
      document.counters["turn.ok"] = 3;
      document.sessions["abc"] = {
        messages: [{ role: "user", content: "hello" }],
        createdAt: 1,
        lastAccessAt: 2,
      };
    });

    expect(await state.read((document) => document.counters["turn.ok"])).toBe(3);
    expect(
      await state.read((document) => document.sessions["abc"].messages[0].content),
    ).toBe("hello");
    expect(client.values.has("voxen:state")).toBe(true);
  });

  it("shares one document across instances using the same key", async () => {
    const first = backend();
    const second = backend();

    await first.write((document) => {
      document.budget.used = 7;
    });

    expect(await second.read((document) => document.budget.used)).toBe(7);
  });

  it("serializes concurrent writes across instances", async () => {
    const first = backend();
    const second = backend();

    await Promise.all([
      first.write(async (document) => {
        document.counters.parallel = (document.counters.parallel ?? 0) + 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return document.counters.parallel;
      }),
      second.write(async (document) => {
        document.counters.parallel = (document.counters.parallel ?? 0) + 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return document.counters.parallel;
      }),
    ]);

    expect(await first.read((document) => document.counters.parallel)).toBe(2);
    expect(client.values.has("voxen:state:lock")).toBe(false);
  });

  it("resets one section without touching the others", async () => {
    const state = backend();
    await state.write((document) => {
      document.counters["turn.ok"] = 1;
      document.samples["turn.total"] = [10];
    });

    await state.reset("samples");

    expect(await state.read((document) => document.counters["turn.ok"])).toBe(1);
    expect(await state.read((document) => document.samples["turn.total"])).toBeUndefined();
  });

  it("fails closed on corrupt stored JSON", async () => {
    client.values.set("voxen:state", "{not json");
    const state = backend();

    await expect(state.read((document) => document.rate)).rejects.toThrow(
      "not valid JSON",
    );
    await expect(state.write(() => undefined)).rejects.toThrow("not valid JSON");
  });

  it("releases the lock when a mutation throws", async () => {
    const state = backend();

    await expect(
      state.write(() => {
        throw new Error("mutation failed");
      }),
    ).rejects.toThrow("mutation failed");

    expect(client.values.has("voxen:state:lock")).toBe(false);
    expect(await state.write(() => "recovered")).toBe("recovered");
  });

  it("times out when another writer holds the lock", async () => {
    const state = backend({ lockTimeoutMs: 0 });
    await client.set("voxen:state:lock", "someone-else");

    await expect(state.write(() => undefined)).rejects.toThrow(
      "Timed out acquiring the Redis state lock",
    );
    expect(client.values.get("voxen:state:lock")).toBe("someone-else");
  });
});
