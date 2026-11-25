import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { readJson } from "@/lib/body";
import { config } from "@/lib/config";
import { addMessage, getHistory } from "@/lib/conversation";
import { evalLabelsFromHeaders, recordEvalTrace } from "@/lib/eval-trace";
import { AppError } from "@/lib/errors";
import { guardRequest, rateLimitHeaders } from "@/lib/guard";
import { jsonOk, toErrorResponse } from "@/lib/http";
import { logEvent, redactSessionId } from "@/lib/logger";
import { withSessionLock } from "@/lib/session-lock";
import {
  MILESTONES,
  STAGES,
  errorCodeOf,
  incrementCounter,
  startTurnTrace,
  type Milestone,
  type Stage,
  type TurnReplay,
} from "@/lib/telemetry";
import { requireSessionId } from "@/lib/validate";
import { getWorkflow, listAppointments } from "@/lib/workflow-store";

interface TurnBody {
  session_id?: unknown;
  user_text?: unknown;
  assistant_text?: unknown;
  interrupted?: unknown;
  elapsed_ms?: unknown;
  milestones_ms?: unknown;
  stages_ms?: unknown;
  tool_calls?: unknown;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null;
}

function boundedNumber(value: unknown, max: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return Math.min(value, max);
}

function replayMap<T extends string>(
  raw: unknown,
  names: readonly T[],
  max: number,
): Partial<Record<T, number>> {
  if (!isRecord(raw)) return {};
  const result: Partial<Record<T, number>> = {};
  for (const name of names) {
    const value = boundedNumber(raw[name], max);
    if (value !== undefined) result[name] = value;
  }
  return result;
}

export const dynamic = "force-dynamic";

/**
 * Commits a completed live turn. The browser owns only text and timing
 * observations; the server owns session isolation, history, and telemetry.
 */
export async function POST(request: NextRequest) {
  const requestId = randomUUID();
  const startedAt = Date.now();
  const labels = evalLabelsFromHeaders(request.headers);

  try {
    const limits = await guardRequest(request, "realtime-turn");
    if (!config.realtimeEnabled) {
      throw new AppError(
        "CONFIG_ERROR",
        "The Realtime transport is disabled.",
        503,
      );
    }

    const body = (await readJson<TurnBody>(request, config.maxChatRequestBytes)) ?? {};
    const sessionId = requireSessionId(body.session_id);
    const userText = typeof body.user_text === "string" ? body.user_text.trim() : "";
    const assistantText =
      typeof body.assistant_text === "string" ? body.assistant_text.trim() : "";
    const maxText = config.maxMessageChars * 4;
    if (userText.length > maxText || assistantText.length > maxText) {
      throw new AppError("MESSAGE_TOO_LONG", "A live turn is too long.", 413);
    }
    if (!userText && !assistantText) {
      throw new AppError(
        "EMPTY_MESSAGE",
        "A live turn needs transcript or reply text.",
        400,
      );
    }

    const interrupted = body.interrupted === true;
    const toolCalls = Array.isArray(body.tool_calls)
      ? body.tool_calls
          .filter((value): value is string => typeof value === "string")
          .slice(0, 20)
      : [];
    const replay: TurnReplay = {
      ...(boundedNumber(body.elapsed_ms, config.turnTimeoutMs) !== undefined
        ? { totalMs: boundedNumber(body.elapsed_ms, config.turnTimeoutMs) }
        : {}),
      milestonesMs: replayMap<Milestone>(
        body.milestones_ms,
        MILESTONES,
        config.turnTimeoutMs,
      ),
      stagesMs: replayMap<Stage>(body.stages_ms, STAGES, config.turnTimeoutMs),
    };

    const result = await withSessionLock(sessionId, async () => {
      const trace = startTurnTrace({
        requestId,
        sessionHash: redactSessionId(sessionId),
        transport: "realtime",
        replay,
      });

      if (userText) await addMessage(sessionId, "user", userText);
      if (assistantText) await addMessage(sessionId, "assistant", assistantText);
      if (interrupted) incrementCounter("realtime.interrupted");

      trace.milestone("complete");
      const snapshot = trace.finish();
      logEvent("turn.trace", { ...snapshot });
      recordEvalTrace({
        ...labels,
        requestId,
        sessionHash: snapshot.sessionHash,
        transport: "realtime",
        promptChars: userText.length,
        answer: assistantText,
        toolCalls,
        events: interrupted ? ["interrupted"] : [],
        latencyMs: snapshot.totalMs,
        status: "ok",
        milestonesMs: snapshot.milestonesMs,
        stagesMs: snapshot.stagesMs,
      });

      const [workflow, appointments] = config.workflowEnabled
        ? await Promise.all([getWorkflow(sessionId), listAppointments(sessionId)])
        : [null, []];

      return {
        session_id: sessionId,
        history: await getHistory(sessionId),
        workflow,
        appointments,
      };
    });

    return jsonOk(result, requestId, 200, rateLimitHeaders(limits));
  } catch (err) {
    recordEvalTrace({
      ...labels,
      requestId,
      transport: "realtime",
      answer: "",
      latencyMs: Date.now() - startedAt,
      status: "error",
      errorCode: errorCodeOf(err),
    });
    return toErrorResponse(err, requestId);
  }
}
