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

describe("workflow TTL configuration", () => {
  afterEach(() => {
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
