import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { ensureAiConfigured, transcribeAudio } from "@/lib/ai";
import { readFormData } from "@/lib/body";
import { config } from "@/lib/config";
import { evalLabelsFromHeaders } from "@/lib/eval-trace";
import { AppError } from "@/lib/errors";
import {
  consumeBudget,
  guardRequest,
  rateLimitHeaders,
  releaseBudget,
} from "@/lib/guard";
import { toErrorResponse } from "@/lib/http";
import { logEvent, redactSessionId } from "@/lib/logger";
import { sseResponse } from "@/lib/sse-response";
import { streamTurn } from "@/lib/streaming";
import {
  errorCodeOf,
  startTurnTrace,
  type TurnTelemetry,
} from "@/lib/telemetry";
import { resolveSessionId } from "@/lib/validate";

export async function POST(request: NextRequest) {
  const requestId = randomUUID();
  const startedAt = Date.now();
  let trace: TurnTelemetry | undefined;

  try {
    const limits = await guardRequest(request, "voice-stream");
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

    trace = startTurnTrace({
      requestId,
      sessionHash: redactSessionId(sessionId),
    });
    await consumeBudget("voice-stream", limits.identity);

    const endStt = trace.stage("stt");
    let transcript: string;
    try {
      transcript = (await transcribeAudio(audio, request.signal)).trim();
    } catch (err) {
      endStt();
      trace.finish(errorCodeOf(err));
      await releaseBudget("voice-stream", limits.identity);
      throw err;
    }
    endStt();
    trace.milestone("transcript");

    if (!transcript) {
      trace.finish("NOTHING_HEARD");
      await releaseBudget("voice-stream", limits.identity);
      throw new AppError("NOTHING_HEARD", "No speech detected in audio", 400);
    }

    return sseResponse(request, {
      requestId,
      headers: rateLimitHeaders(limits),
      run: async (send, signal) => {
        send("session", { session_id: sessionId });
        send("transcript", { transcript });

        try {
          const reply = await streamTurn({
            sessionId,
            userContent: transcript,
            requestId,
            signal,
            send,
            speak: formData.get("speak") !== "false",
            trace,
            eval: evalLabelsFromHeaders(request.headers),
            transport: "sse",
          });

          logEvent("voice.stream.completed", {
            requestId,
            sessionId: redactSessionId(sessionId),
            durationMs: Date.now() - startedAt,
            audioBytes: audio.size,
            transcriptChars: transcript.length,
            replyChars: reply.length,
          });
        } catch (err) {
          if (!signal.aborted) await releaseBudget("voice-stream", limits.identity);
          throw err;
        }
      },
    });
  } catch (err) {
    trace?.finish(errorCodeOf(err));
    return toErrorResponse(err, requestId);
  }
}
