import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { ensureAiConfigured } from "@/lib/ai";
import { readJson } from "@/lib/body";
import { config } from "@/lib/config";
import { AppError } from "@/lib/errors";
import {
  consumeBudget,
  guardRequest,
  rateLimitHeaders,
  releaseBudget,
} from "@/lib/guard";
import { jsonOk, toErrorResponse } from "@/lib/http";
import { errorMessage, logWarning, redactSessionId } from "@/lib/logger";
import {
  releaseRealtimeSession,
  startRealtimeSession,
} from "@/lib/realtime-budget";
import { resolveSessionId } from "@/lib/validate";

interface TokenBody {
  session_id?: unknown;
}

export const dynamic = "force-dynamic";

/**
 * Mints a short-lived Realtime client secret. The OpenAI API key and session
 * policy stay on the server; the browser receives only the ephemeral value.
 */
export async function POST(request: NextRequest) {
  const requestId = randomUUID();
  let sessionId = "";
  let budgetConsumed = false;
  let sessionReserved = false;

  try {
    const limits = guardRequest(request, "realtime-token");
    ensureAiConfigured();
    if (!config.realtimeEnabled) {
      throw new AppError(
        "CONFIG_ERROR",
        "The Realtime transport is disabled.",
        503,
      );
    }

    const body = await readJson<TokenBody>(request, config.maxChatRequestBytes);
    sessionId = resolveSessionId(body?.session_id);

    consumeBudget("realtime-token");
    budgetConsumed = true;
    startRealtimeSession(sessionId);
    sessionReserved = true;

    const response = await fetch(
      "https://api.openai.com/v1/realtime/client_secrets",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.openaiApiKey}`,
          "Content-Type": "application/json",
          "OpenAI-Safety-Identifier": redactSessionId(sessionId),
        },
        body: JSON.stringify({
          session: {
            type: "realtime",
            model: config.realtimeModel,
            instructions: config.realtimeInstructions,
            audio: {
              output: { voice: config.realtimeVoice },
              input: {
                transcription: { model: config.sttModel },
                // Server VAD cancels an in-progress answer as soon as the user
                // starts speaking, which provides natural full-duplex barge-in.
                turn_detection: {
                  type: "server_vad",
                  interrupt_response: true,
                },
              },
            },
            max_output_tokens: config.realtimeMaxOutputTokens,
          },
        }),
        signal: AbortSignal.timeout(config.openaiTimeoutMs),
        cache: "no-store",
      },
    );

    if (!response.ok) {
      throw new AppError(
        "REALTIME_FAILED",
        `Realtime token service returned HTTP ${response.status}`,
        502,
      );
    }

    const data = (await response.json()) as {
      value?: unknown;
      expires_at?: unknown;
    };
    if (typeof data.value !== "string" || !data.value) {
      throw new AppError(
        "REALTIME_FAILED",
        "Realtime token service returned an empty secret",
        502,
      );
    }

    return jsonOk(
      {
        value: data.value,
        ...(typeof data.expires_at === "string"
          ? { expires_at: data.expires_at }
          : {}),
        session_id: sessionId,
        model: config.realtimeModel,
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
    if (sessionReserved) releaseRealtimeSession(sessionId);
    if (budgetConsumed) releaseBudget("realtime-token");
    logWarning("realtime.token_failed", {
      requestId,
      message: errorMessage(err),
    });
    return toErrorResponse(err, requestId);
  }
}
