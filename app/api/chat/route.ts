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
import { evalLabelsFromHeaders, recordEvalTrace } from "@/lib/eval-trace";
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
  const labels = evalLabelsFromHeaders(request.headers);
  const toolCalls: string[] = [];
  const events: string[] = [];
  let trace: TurnTelemetry | undefined;
  let promptChars: number | undefined;

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
    promptChars = message.length;
    trace = startTurnTrace({
      requestId,
      sessionId,
      transport: "http",
    });
    trace.milestone("transcript");

    consumeBudget("chat", limits.identity);
    let reply: string;
    const endLlm = trace.stage("llm");
    try {
      reply = await generateResponse(
        buildRequestMessages(sessionId, message),
        { sessionId },
        { onToolCall: (name) => toolCalls.push(name) },
      );
    } catch (err) {
      releaseBudget("chat", limits.identity);
      throw err;
    } finally {
      endLlm();
    }
    appendTurn(sessionId, message, reply);
    trace.milestone("done");

    let audio: string | null = null;
    if (body?.speak === true) {
      const endTts = trace.stage("tts");
      try {
        audio = await synthesizeSpeech(reply);
      } catch (err) {
        events.push("provider_error", "resumed");
        logWarning("chat.tts_unavailable", {
          requestId,
          message: errorMessage(err),
        });
      } finally {
        endTts();
      }
    }
    trace.milestone("complete");
    const snapshot = trace.finish();
    if (snapshot.status === "ok") logEvent("turn.trace", { ...snapshot });

    recordEvalTrace({
      ...labels,
      requestId,
      sessionHash: snapshot.sessionHash,
      transport: "http",
      promptChars,
      answer: reply,
      toolCalls,
      events,
      latencyMs: snapshot.totalMs,
      status: "ok",
      milestonesMs: snapshot.milestonesMs,
      stagesMs: snapshot.stagesMs,
    });

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
    const code = errorCodeOf(err);
    const snapshot = trace?.finish(code);
    if (snapshot) logEvent("turn.trace", { ...snapshot });
    recordEvalTrace({
      ...labels,
      requestId,
      sessionHash: snapshot?.sessionHash,
      transport: "http",
      promptChars,
      answer: "",
      toolCalls,
      events,
      latencyMs: snapshot?.totalMs ?? Date.now() - startedAt,
      status: "error",
      errorCode: code,
      milestonesMs: snapshot?.milestonesMs,
      stagesMs: snapshot?.stagesMs,
    });
    return toErrorResponse(err, requestId);
  }
}
