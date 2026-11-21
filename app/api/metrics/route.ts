import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { guardRequest, rateLimitHeaders } from "@/lib/guard";
import { jsonOk, toErrorResponse } from "@/lib/http";
import { telemetrySnapshot } from "@/lib/telemetry";

export const dynamic = "force-dynamic";

/**
 * Operational metrics for the in-process telemetry registry. Guarded like the
 * paid routes because stage timings reveal usage patterns; it consumes no AI
 * budget and exposes no transcript content.
 */
export async function GET(request: NextRequest) {
  const requestId = randomUUID();

  try {
    const limits = guardRequest(request, "metrics");
    return jsonOk(
      { status: "ok", ...telemetrySnapshot() },
      requestId,
      200,
      rateLimitHeaders(limits),
    );
  } catch (err) {
    return toErrorResponse(err, requestId);
  }
}
