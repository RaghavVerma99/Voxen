import { randomUUID } from "node:crypto";
import { isAiConfigured } from "@/lib/config";
import { jsonOk } from "@/lib/http";

/**
 * Readiness probe for orchestrators. Liveness stays at /api/health; this
 * endpoint fails when the process is up but cannot serve AI requests.
 */
export async function GET() {
  const requestId = randomUUID();

  if (!isAiConfigured()) {
    return jsonOk(
      { status: "not_ready", reason: "ai_not_configured" },
      requestId,
      503,
    );
  }

  return jsonOk({ status: "ready" }, requestId);
}
