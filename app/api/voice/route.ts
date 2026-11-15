import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import {
  ensureAiConfigured,
  generateResponse,
  synthesizeSpeech,
  transcribeAudio,
} from "@/lib/ai";
import { readFormData } from "@/lib/body";
import { config } from "@/lib/config";
import {
  appendTurn,
  buildRequestMessages,
  getHistory,
} from "@/lib/conversation";
import { AppError } from "@/lib/errors";
import { consumeBudget, guardRequest, rateLimitHeaders } from "@/lib/guard";
import { jsonOk, toErrorResponse } from "@/lib/http";
import {
  errorMessage,
  logEvent,
  logWarning,
  redactSessionId,
} from "@/lib/logger";
import { resolveSessionId } from "@/lib/validate";

export async function POST(request: NextRequest) {
  const requestId = randomUUID();
  const startedAt = Date.now();

  try {
    const limits = guardRequest(request, "voice");
    ensureAiConfigured();

    const formData = await readFormData(
      request,
      config.maxVoiceRequestBytes,
    );
    const audio = formData.get("audio");
    const sessionId = resolveSessionId(formData.get("session_id"));
    const duration = Number(formData.get("audio_duration"));
    const speak = formData.get("speak") !== "false";

    if (!(audio instanceof File) || audio.size === 0) {
      throw new AppError("EMPTY_AUDIO", "No audio received", 400);
    }
    if (audio.size > config.maxAudioBytes) {
      throw new AppError(
        "AUDIO_TOO_LARGE",
        `Audio exceeds ${Math.floor(config.maxAudioBytes / (1024 * 1024))}MB limit`,
        413,
      );
    }
    if (Number.isFinite(duration) && duration > config.maxAudioSeconds) {
      throw new AppError(
        "AUDIO_TOO_LONG",
        `Audio exceeds ${config.maxAudioSeconds}s limit`,
        413,
      );
    }

    consumeBudget("voice");
    const transcript = (await transcribeAudio(audio)).trim();
    if (!transcript) {
      throw new AppError("NOTHING_HEARD", "No speech detected in audio", 400);
    }

    const reply = await generateResponse(
      buildRequestMessages(sessionId, transcript),
    );
    appendTurn(sessionId, transcript, reply);

    let audioB64: string | null = null;
    if (speak) {
      try {
        audioB64 = await synthesizeSpeech(reply);
      } catch (err) {
        logWarning("voice.tts_unavailable", {
          requestId,
          message: errorMessage(err),
        });
      }
    }

    logEvent("voice.completed", {
      requestId,
      sessionId: redactSessionId(sessionId),
      durationMs: Date.now() - startedAt,
      audioBytes: audio.size,
      transcriptChars: transcript.length,
      spoken: audioB64 !== null,
    });

    return jsonOk(
      {
        session_id: sessionId,
        transcript,
        reply,
        audio: audioB64,
        history: getHistory(sessionId),
      },
      requestId,
      200,
      rateLimitHeaders(limits),
    );
  } catch (err) {
    return toErrorResponse(err, requestId);
  }
}
