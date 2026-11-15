import { streamResponse, synthesizeSpeech } from "./ai";
import {
  appendTurn,
  buildRequestMessages,
  getHistory,
} from "./conversation";
import { errorMessage, logWarning } from "./logger";
import { SentenceChunker } from "./sse";

export interface StreamTurnOptions {
  sessionId: string;
  userContent: string;
  requestId: string;
  signal: AbortSignal;
  send: (event: string, data: unknown) => void;
  speak?: boolean;
}

/**
 * Runs one streamed turn: model text is forwarded as it arrives, sentences
 * are synthesized in order as a background queue, and the turn is committed
 * only after the model finishes successfully.
 */
export async function streamTurn(options: StreamTurnOptions): Promise<string> {
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
  await audioChain;

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

  return reply;
}
