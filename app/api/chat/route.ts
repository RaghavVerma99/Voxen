import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { ensureAiConfigured, generateResponse, synthesizeSpeech } from "@/lib/ai";
import { config } from "@/lib/config";
import {
  appendTurn,
  buildRequestMessages,
  getHistory,
} from "@/lib/conversation";
import { AppError } from "@/lib/errors";
import { consumeBudget, guardRequest } from "@/lib/guard";
import { jsonOk, toErrorResponse } from "@/lib/http";
import { errorMessage, logEvent, logWarning } from "@/lib/logger";
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
    guardRequest(request, "chat");
    ensureAiConfigured();

    const body = (await request.json().catch(() => null)) as ChatBody | null;
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
      sessionId,
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
    );
  } catch (err) {
    return toErrorResponse(err, requestId);
  }
}
