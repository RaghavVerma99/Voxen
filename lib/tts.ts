import { config, ttsProviderChain, type TtsProvider } from "./config";
import { AppError } from "./errors";
import { errorMessage, logWarning } from "./logger";
import { openaiClient } from "./openai-client";
import { synthesizeSpeechRealtime } from "./realtime-tts";

const TTS_MAX_INPUT_CHARS = 4_000;

export type TtsProviderName = TtsProvider;
export type Synthesize = (text: string, signal?: AbortSignal) => Promise<string>;

interface SpeechAdapter {
  name: TtsProviderName;
  synthesize: Synthesize;
}

/**
 * The legacy Speech API is intentionally kept as a short-term failover beside
 * the Realtime narrator. Both adapters return WAV/base64 so playback code does
 * not need to know which provider produced the bytes.
 */
const adapters: Record<TtsProviderName, SpeechAdapter> = {
  speech: {
    name: "speech",
    synthesize: async (text, signal) => {
      const response = await openaiClient().audio.speech.create(
        {
          model: config.ttsModel,
          voice: config.ttsVoice,
          response_format: "wav",
          input: text,
        },
        { signal },
      );
      const audio = await response.arrayBuffer();
      return Buffer.from(audio).toString("base64");
    },
  },
  realtime: {
    name: "realtime",
    synthesize: (text, signal) => synthesizeSpeechRealtime(text, signal),
  },
};

function isAbortError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === "AbortError" || err.name === "APIUserAbortError")
  );
}

function providerChain(): SpeechAdapter[] {
  return ttsProviderChain().map((name) => adapters[name]);
}

/**
 * Synthesizes one sentence with ordered failover. A provider-specific failure
 * is logged and retried on the next adapter; a cancelled request is never
 * retried because the caller has already stopped listening.
 */
export async function synthesizeSpeech(
  text: string,
  signal?: AbortSignal,
): Promise<string> {
  const input =
    text.length > TTS_MAX_INPUT_CHARS
      ? `${text.slice(0, TTS_MAX_INPUT_CHARS - 3)}...`
      : text;

  let lastError: unknown = new Error("No TTS provider configured");

  for (const adapter of providerChain()) {
    try {
      return await adapter.synthesize(input, signal);
    } catch (err) {
      if (isAbortError(err)) throw err;
      lastError = err;
      logWarning("tts.provider_failed", {
        provider: adapter.name,
        message: errorMessage(err),
      });
    }
  }

  throw new AppError("TTS_FAILED", errorMessage(lastError), 502);
}
