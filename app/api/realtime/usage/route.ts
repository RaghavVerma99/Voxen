import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { readJson } from "@/lib/body";
import { config } from "@/lib/config";
import { guardRequest, rateLimitHeaders } from "@/lib/guard";
import { jsonOk, toErrorResponse } from "@/lib/http";
import { recordRealtimeUsage } from "@/lib/realtime-budget";
import { resolveSessionId } from "@/lib/validate";

interface UsageBody {
  session_id?: unknown;
  audio_seconds?: unknown;
  output_tokens?: unknown;
}

export const dynamic = "force-dynamic";

/** Records final Realtime usage so audio-minute and token caps are enforced. */
export async function POST(request: NextRequest) {
  const requestId = randomUUID();

  try {
    const limits = guardRequest(request, "realtime-usage");
    const body =
      (await readJson<UsageBody>(request, config.maxChatRequestBytes)) ?? {};
    const sessionId = resolveSessionId(body?.session_id);
    const usage = recordRealtimeUsage(sessionId, {
      audioSeconds: body.audio_seconds,
      outputTokens: body.output_tokens,
    });

    return jsonOk(
      {
        session_id: sessionId,
        usage,
        limits: {
          audio_seconds: config.realtimeMaxAudioSeconds,
          output_tokens: config.realtimeMaxOutputTokens,
        },
      },
      requestId,
      200,
      rateLimitHeaders(limits),
    );
  } catch (err) {
    return toErrorResponse(err, requestId);
  }
}
