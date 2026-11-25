import { beforeEach, describe, expect, it, vi } from "vitest";

const { connect, destroy } = vi.hoisted(() => ({
  connect: vi.fn(),
  destroy: vi.fn(),
}));

vi.mock("redis", () => ({
  createClient: () => ({
    on: vi.fn(),
    connect,
    destroy,
  }),
}));

import { createRedisStateBackend } from "@/lib/state";

describe("Redis state connection failures", () => {
  const secretUrl = "redis://user:super-secret@cache.internal:6379";

  beforeEach(() => {
    connect.mockReset();
    destroy.mockReset();
    connect.mockRejectedValue(new Error(`AUTH failed for ${secretUrl}`));
  });

  it("fails closed without exposing the connection URL or credentials", async () => {
    const state = createRedisStateBackend({ url: secretUrl, key: "voxen:state" });

    await expect(state.read((document) => document.budget)).rejects.toThrow(
      "Unable to connect to the Redis state store.",
    );
    try {
      await state.read((document) => document.budget);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain("super-secret");
      expect(message).not.toContain("cache.internal");
    }
    expect(destroy).toHaveBeenCalled();
  });

  it("retries with a fresh client after a failed connection", async () => {
    const state = createRedisStateBackend({ url: secretUrl, key: "voxen:state" });

    await expect(state.write(() => undefined)).rejects.toThrow(
      "Unable to connect to the Redis state store.",
    );
    await expect(state.write(() => undefined)).rejects.toThrow(
      "Unable to connect to the Redis state store.",
    );

    expect(connect).toHaveBeenCalledTimes(2);
  });
});
