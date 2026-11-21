import { streamResponse, synthesizeSpeech } from "./ai";
import {
  appendTurn,
  buildRequestMessages,
  getHistory,
} from "./conversation";
import { errorMessage, logEvent, logWarning } from "./logger";
import { withSessionLock } from "./session-lock";
import { SentenceChunker } from "./sse";
import {
  errorCodeOf,
  incrementCounter,
  type TurnTelemetry,
} from "./telemetry";

export interface StreamTurnOptions {
  sessionId: string;
  userContent: string;
  requestId: string;
  signal: AbortSignal;
  send: (event: string, data: unknown) => void;
  speak?: boolean;
  trace?: TurnTelemetry;
}

interface TurnOutcome {
  reply: string;
  audioChain: Promise<void>;
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
  try {
    const outcome = await withSessionLock(options.sessionId, () =>
      runTurn(options),
    );
    await outcome.audioChain;
    options.trace?.milestone("complete");

    const snapshot = options.trace?.finish();
    if (snapshot) logEvent("turn.trace", { ...snapshot });
    return outcome.reply;
  } catch (err) {
    const snapshot = options.trace?.finish(errorCodeOf(err));
    if (snapshot) logEvent("turn.trace", { ...snapshot });
    throw err;
  }
}

async function runTurn(options: StreamTurnOptions): Promise<TurnOutcome> {
  if (options.signal.aborted) throw abortError();

  const chunker = new SentenceChunker();
  let audioIndex = 0;
  let audioChain = Promise.resolve();

  const queueAudio = (text: string): void => {
    if (options.speak === false) return;
    const chunk = text.trim();
    if (!chunk) return;

    audioChain = audioChain.then(async () => {
      if (options.signal.aborted) return;
      const endTts = options.trace?.stage("tts");
      try {
        const audio = await synthesizeSpeech(chunk, options.signal);
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
      buildRequestMessages(options.sessionId, options.userContent),
      {
        signal: options.signal,
        onDelta: (delta) => {
          options.trace?.milestone("first_delta");
          options.send("delta", { text: delta });
          for (const chunk of chunker.push(delta)) queueAudio(chunk);
        },
      },
      { sessionId: options.sessionId },
    );
  } finally {
    endLlm?.();
  }

  for (const chunk of chunker.flush()) queueAudio(chunk);

  // A cancelled turn is never committed, so client and server agree on what
  // happened even if the user stops generation midway.
  if (!options.signal.aborted) {
    appendTurn(options.sessionId, options.userContent, reply);
    options.send("done", {
      session_id: options.sessionId,
      reply,
      history: getHistory(options.sessionId),
      spoken: options.speak !== false,
    });
    options.trace?.milestone("done");
  }

  return { reply, audioChain };
}

function abortError(): Error {
  const err = new Error("The turn was cancelled.");
  err.name = "AbortError";
  return err;
}
