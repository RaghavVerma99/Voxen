import { streamResponse, synthesizeSpeech } from "./ai";
import { config } from "./config";
import {
  appendTurn,
  buildRequestMessages,
  getHistory,
} from "./conversation";
import { recordEvalTrace, type EvalLabels } from "./eval-trace";
import { errorMessage, logEvent, logWarning } from "./logger";
import { withSessionLock } from "./session-lock";
import { SentenceChunker } from "./sse";
import {
  errorCodeOf,
  incrementCounter,
  type TurnTelemetry,
  type TurnTransport,
} from "./telemetry";
import { getWorkflow, listAppointments } from "./workflow-store";

export interface StreamTurnOptions {
  sessionId: string;
  userContent: string;
  requestId: string;
  signal: AbortSignal;
  send: (event: string, data: unknown) => void;
  speak?: boolean;
  trace?: TurnTelemetry;
  /** Optional labels from the eval recorder; ignored during normal traffic. */
  eval?: EvalLabels;
  transport?: TurnTransport;
}

interface TurnOutcome {
  reply: string;
  audioChain: Promise<void>;
  /** Releases audio events if the turn ends before `done` is sent. */
  unlockAudio: () => void;
}

interface TurnObservations {
  toolCalls: string[];
  events: string[];
}

/**
 * Runs one streamed turn. Turns for the same session are serialized so a
 * second request cannot read history before the first one commits.
 *
 * The turn is committed and `done` is sent as soon as the model finishes.
 * Speech synthesis keeps draining in the background for the same connection,
 * so a slow TTS provider cannot delay the client's text or history update.
 */
export async function streamTurn(options: StreamTurnOptions): Promise<string> {
  const observed: TurnObservations = { toolCalls: [], events: [] };

  try {
    const outcome = await withSessionLock(options.sessionId, () =>
      runTurn(options, observed),
    );
    try {
      await outcome.audioChain;
      options.trace?.milestone("complete");
    } finally {
      outcome.unlockAudio();
    }

    const snapshot = options.trace?.finish();
    if (snapshot) logEvent("turn.trace", { ...snapshot });
    if (observed.events.includes("provider_error")) {
      observed.events.push("resumed");
    }
    recordEvalTrace({
      ...options.eval,
      requestId: options.requestId,
      sessionHash: snapshot?.sessionHash,
      transport: options.transport ?? "sse",
      promptChars: options.userContent.length,
      answer: outcome.reply,
      toolCalls: observed.toolCalls,
      events: observed.events,
      latencyMs: snapshot?.totalMs ?? 0,
      status: "ok",
      milestonesMs: snapshot?.milestonesMs,
      stagesMs: snapshot?.stagesMs,
    });
    return outcome.reply;
  } catch (err) {
    const code = errorCodeOf(err);
    const snapshot = options.trace?.finish(code);
    if (snapshot) logEvent("turn.trace", { ...snapshot });
    if (!options.signal.aborted) {
      recordEvalTrace({
        ...options.eval,
        requestId: options.requestId,
        sessionHash: snapshot?.sessionHash,
        transport: options.transport ?? "sse",
        promptChars: options.userContent.length,
        answer: "",
        toolCalls: observed.toolCalls,
        events: observed.events,
        latencyMs: snapshot?.totalMs ?? 0,
        status: "error",
        errorCode: code,
        milestonesMs: snapshot?.milestonesMs,
        stagesMs: snapshot?.stagesMs,
      });
    }
    throw err;
  }
}

async function runTurn(
  options: StreamTurnOptions,
  observed: TurnObservations,
): Promise<TurnOutcome> {
  if (options.signal.aborted) throw abortError();

  const chunker = new SentenceChunker();
  let audioIndex = 0;
  let audioChain = Promise.resolve();
  let unlockAudio = (): void => {};
  // Audio is synthesized while the model streams, but only emitted after the
  // committed `done` event so clients always see text/history first.
  const audioGate = new Promise<void>((resolve) => {
    unlockAudio = resolve;
  });

  const queueAudio = (text: string): void => {
    if (options.speak === false) return;
    const chunk = text.trim();
    if (!chunk) return;

    audioChain = audioChain.then(async () => {
      if (options.signal.aborted) return;
      const endTts = options.trace?.stage("tts");
      try {
        const audio = await synthesizeSpeech(chunk, options.signal);
        await audioGate;
        if (!options.signal.aborted) {
          // Assign the index at send time, after earlier chunks have finished,
          // so a failed sentence cannot leave a gap that stalls playback.
          options.send("audio", { index: audioIndex, audio });
          audioIndex += 1;
          options.trace?.milestone("first_audio");
          incrementCounter("audio.sentences");
        }
      } catch (err) {
        if (options.signal.aborted) return;
        observed.events.push("provider_error");
        logWarning("stream.tts_unavailable", {
          requestId: options.requestId,
          message: errorMessage(err),
        });
      } finally {
        endTts?.();
      }
    });
  };

  const endLlm = options.trace?.stage("llm");
  let reply: string;
  try {
    reply = await streamResponse(
      await buildRequestMessages(options.sessionId, options.userContent),
      {
        signal: options.signal,
        onDelta: (delta) => {
          options.trace?.milestone("first_delta");
          options.send("delta", { text: delta });
          for (const chunk of chunker.push(delta)) queueAudio(chunk);
        },
        onToolCall: (name) => observed.toolCalls.push(name),
      },
      { sessionId: options.sessionId, source: "sse" },
    );
  } finally {
    endLlm?.();
  }

  for (const chunk of chunker.flush()) queueAudio(chunk);

  // A cancelled turn is never committed, so client and server agree on what
  // happened even if the user stops generation midway.
  if (!options.signal.aborted) {
    await appendTurn(options.sessionId, options.userContent, reply);
    options.send("done", {
      session_id: options.sessionId,
      reply,
      history: await getHistory(options.sessionId),
      spoken: options.speak !== false,
    });
    unlockAudio();
    options.trace?.milestone("done");

    if (config.workflowEnabled) {
      try {
        const [workflow, appointments] = await Promise.all([
          getWorkflow(options.sessionId),
          listAppointments(options.sessionId),
        ]);
        options.send("workflow", { workflow, appointments });
      } catch (err) {
        // The turn is already committed; a state refresh must not fail it.
        logWarning("workflow.state_unavailable", {
          requestId: options.requestId,
          message: errorMessage(err),
        });
      }
    }
  }

  return { reply, audioChain, unlockAudio };
}

function abortError(): Error {
  const err = new Error("The turn was cancelled.");
  err.name = "AbortError";
  return err;
}
