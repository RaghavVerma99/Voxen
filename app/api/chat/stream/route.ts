import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { ensureAiConfigured } from "@/lib/ai";
import { readJson } from "@/lib/body";
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

interface ChatBody {
  session_id?: unknown;
  message?: unknown;
  speak?: unknown;
}

export async function POST(request: NextRequest) {
  const requestId = randomUUID();
  const startedAt = Date.now();
  let trace: TurnTelemetry | undefined;

  try {
    const limits = guardRequest(request, "chat-stream");
    ensureAiConfigured();

    const body = await readJson<ChatBody>(request, config.maxChatRequestBytes);
    const message = typeof body?.message === "string" ? body.message.trim() : "";

    if (!message) {
      throw new AppError("EMPTY_MESSAGE", "Message is empty", 400);
    }
    if (message.length > config.maxMessageChars) {
      throw new AppError(
        "MESSAGE_TOO_LONG",
        `Message exceeds ${config.maxMessageChars} characters`,
        413,
      );
    }

    const sessionId = resolveSessionId(body?.session_id);
    trace = startTurnTrace({
      requestId,
      sessionHash: redactSessionId(sessionId),
    });
    consumeBudget("chat-stream", limits.identity);

    return sseResponse(request, {
      requestId,
      headers: rateLimitHeaders(limits),
      run: async (send, signal) => {
        send("session", { session_id: sessionId });

        try {
          const reply = await streamTurn({
            sessionId,
            userContent: message,
            requestId,
            signal,
            send,
            speak: body?.speak !== false,
            trace,
            eval: evalLabelsFromHeaders(request.headers),
            transport: "sse",
          });

          logEvent("chat.stream.completed", {
            requestId,
            sessionId: redactSessionId(sessionId),
            durationMs: Date.now() - startedAt,
            messageChars: message.length,
            replyChars: reply.length,
          });
        } catch (err) {
          if (!signal.aborted) releaseBudget("chat-stream", limits.identity);
          throw err;
        }
      },
    });
  } catch (err) {
    trace?.finish(errorCodeOf(err));
    return toErrorResponse(err, requestId);
  }
}
