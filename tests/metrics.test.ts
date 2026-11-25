import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";

import { GET as getMetrics } from "@/app/api/metrics/route";
import { config } from "@/lib/config";
import {
  incrementCounter,
  recordTiming,
  resetTelemetry,
} from "@/lib/telemetry";

async function bodyOf(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

beforeEach(async () => {
  await resetTelemetry();
  config.accessCode = "";
  config.rateLimitRequests = 1_000;
  await recordTiming("turn.total", 12);
  await incrementCounter("turn.ok");
});

describe("metrics route", () => {
  it("returns the telemetry snapshot for an authorized caller", async () => {
    const response = await getMetrics(
      new NextRequest("http://localhost/api/metrics"),
    );
    const body = await bodyOf(response);

    expect(response.status).toBe(200);
    expect(response.headers.get("RateLimit-Limit")).toBe("1000");
    expect(body.status).toBe("ok");
    expect(body.counters).toMatchObject({ "turn.ok": 1 });
    expect(body.timings).toMatchObject({
      "turn.total": { count: 1, p50: 12, p95: 12 },
    });
  });

  it("respects the shared access gate", async () => {
    config.accessCode = "secret-code";

    const denied = await getMetrics(
      new NextRequest("http://localhost/api/metrics"),
    );
    expect(denied.status).toBe(401);

    const allowed = await getMetrics(
      new NextRequest("http://localhost/api/metrics", {
        headers: { "x-access-code": "secret-code" },
      }),
    );
    expect(allowed.status).toBe(200);
  });
});
