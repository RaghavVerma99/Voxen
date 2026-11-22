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
import {
  consumeBudget,
  guardRequest,
  rateLimitHeaders,
  releaseBudget,
} from "@/lib/guard";
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
    const durationRaw = formData.get("audio_duration");
    const duration =
      typeof durationRaw === "string" ? Number(durationRaw) : Number.NaN;
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
    if (
      typeof durationRaw !== "string" ||
      durationRaw.trim() === "" ||
      !Number.isFinite(duration) ||
      duration < 0
    ) {
      throw new AppError(
        "INVALID_AUDIO_DURATION",
        "audio_duration is required and must be a non-negative number of seconds",
        400,
      );
    }
    if (duration > config.maxAudioSeconds) {
      throw new AppError(
        "AUDIO_TOO_LONG",
        `Audio exceeds ${config.maxAudioSeconds}s limit`,
        413,
      );
    }

    consumeBudget("voice", limits.identity);
    let transcript: string;
    try {
      transcript = (await transcribeAudio(audio, request.signal)).trim();
    } catch (err) {
      releaseBudget("voice", limits.identity);
      throw err;
    }
    if (!transcript) {
      releaseBudget("voice", limits.identity);
      throw new AppError("NOTHING_HEARD", "No speech detected in audio", 400);
    }

    let reply: string;
    try {
      reply = await generateResponse(
        buildRequestMessages(sessionId, transcript),
        { sessionId },
      );
    } catch (err) {
      releaseBudget("voice", limits.identity);
      throw err;
    }
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
