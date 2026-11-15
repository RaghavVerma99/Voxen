import { randomUUID } from "node:crypto";
import {
  isAiConfigured,
  isProductionAccessMisconfigured,
} from "@/lib/config";
import { jsonOk } from "@/lib/http";

// Env is read at request time; never bake a build-time readiness result.
export const dynamic = "force-dynamic";

/**
 * Readiness probe for orchestrators. Liveness stays at /api/health; this
 * endpoint fails when the process is up but cannot safely serve requests.
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

  if (isProductionAccessMisconfigured()) {
    return jsonOk(
      { status: "not_ready", reason: "access_code_not_configured" },
      requestId,
      503,
    );
  }

  return jsonOk({ status: "ready" }, requestId);
}
