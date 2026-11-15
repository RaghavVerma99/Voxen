import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { ensureAiConfigured, generateResponse, synthesizeSpeech } from "@/lib/ai";
import { readJson } from "@/lib/body";
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

interface ChatBody {
  session_id?: unknown;
  message?: unknown;
  speak?: unknown;
}

export async function POST(request: NextRequest) {
  const requestId = randomUUID();
  const startedAt = Date.now();

  try {
    const limits = guardRequest(request, "chat");
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
    consumeBudget("chat");
    const reply = await generateResponse(buildRequestMessages(sessionId, message));
    appendTurn(sessionId, message, reply);

    let audio: string | null = null;
    if (body?.speak === true) {
      try {
        audio = await synthesizeSpeech(reply);
      } catch (err) {
        logWarning("chat.tts_unavailable", {
          requestId,
          message: errorMessage(err),
        });
      }
    }

    logEvent("chat.completed", {
      requestId,
      sessionId: redactSessionId(sessionId),
      durationMs: Date.now() - startedAt,
      messageChars: message.length,
      spoken: audio !== null,
    });

    return jsonOk(
      {
        session_id: sessionId,
        reply,
        audio,
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
