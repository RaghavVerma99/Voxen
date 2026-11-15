import { streamResponse, synthesizeSpeech } from "./ai";
import {
  appendTurn,
  buildRequestMessages,
  getHistory,
} from "./conversation";
import { errorMessage, logWarning } from "./logger";
import { withSessionLock } from "./session-lock";
import { SentenceChunker } from "./sse";

export interface StreamTurnOptions {
  sessionId: string;
  userContent: string;
  requestId: string;
  signal: AbortSignal;
  send: (event: string, data: unknown) => void;
  speak?: boolean;
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
  const outcome = await withSessionLock(options.sessionId, () =>
    runTurn(options),
  );

  await outcome.audioChain;
  return outcome.reply;
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
      try {
        const audio = await synthesizeSpeech(chunk, options.signal);
        if (!options.signal.aborted) {
          // Assign the index at send time, after earlier chunks have finished,
          // so a failed sentence cannot leave a gap that stalls playback.
          options.send("audio", { index: audioIndex, audio });
          audioIndex += 1;
        }
      } catch (err) {
        if (options.signal.aborted) return;
        logWarning("stream.tts_unavailable", {
          requestId: options.requestId,
          message: errorMessage(err),
        });
      }
    });
  };

  const reply = await streamResponse(
    buildRequestMessages(options.sessionId, options.userContent),
    {
      signal: options.signal,
      onDelta: (delta) => {
        options.send("delta", { text: delta });
        for (const chunk of chunker.push(delta)) queueAudio(chunk);
      },
    },
  );

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
  }

  return { reply, audioChain };
}

function abortError(): Error {
  const err = new Error("The turn was cancelled.");
  err.name = "AbortError";
  return err;
}
