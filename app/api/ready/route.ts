import { randomUUID } from "node:crypto";
import {
  isAiConfigured,
  isProductionAccessMisconfigured,
  ttsProviderChain,
} from "@/lib/config";
import { jsonOk } from "@/lib/http";

// Env is read at request time; never bake a build-time readiness result.
export const dynamic = "force-dynamic";

/**
 * Readiness probe for orchestrators. Liveness stays at /api/health; this
 * endpoint fails when the process is up but cannot safely serve requests.
 * The TTS chain is reported so a deployment can confirm its migration state.
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

  return jsonOk(
    {
      status: "ready",
      tts: {
        primary: ttsProviderChain()[0],
        fallback: ttsProviderChain()[1] ?? "none",
        chain: ttsProviderChain(),
      },
    },
    requestId,
  );
}
