import { describe, expect, it } from "vitest";
import { buildContentSecurityPolicy } from "@/lib/csp";

describe("buildContentSecurityPolicy", () => {
  const base = { nonce: "bm9uY2U", isDev: false };

  it("keeps connect-src narrow when Realtime is disabled", () => {
    const policy = buildContentSecurityPolicy({
      ...base,
      realtimeEnabled: false,
    });

    expect(policy).toContain("connect-src 'self'");
    expect(policy).not.toContain("api.openai.com");
    expect(policy).not.toContain("wss://");
    expect(policy).toContain("default-src 'self'");
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain("frame-ancestors 'none'");
  });

  it("allows only the Realtime signaling and socket origins when enabled", () => {
    const policy = buildContentSecurityPolicy({
      ...base,
      realtimeEnabled: true,
    });

    expect(policy).toContain(
      "connect-src 'self' https://api.openai.com wss://api.openai.com",
    );
    expect(policy).not.toContain("connect-src *");
  });

  it("relaxes nonce-only styles in development", () => {
    const dev = buildContentSecurityPolicy({
      nonce: "bm9uY2U",
      isDev: true,
      realtimeEnabled: false,
    });
    const prod = buildContentSecurityPolicy({
      nonce: "bm9uY2U",
      isDev: false,
      realtimeEnabled: false,
    });

    expect(dev).toContain("style-src 'self' 'unsafe-inline'");
    expect(dev).toContain("script-src 'self' 'nonce-bm9uY2U' 'strict-dynamic' 'unsafe-eval'");
    expect(dev).not.toContain("upgrade-insecure-requests");
    expect(prod).toContain("style-src 'self' 'nonce-bm9uY2U'");
    expect(prod).toContain("upgrade-insecure-requests");
  });
});
