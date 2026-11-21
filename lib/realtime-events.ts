export interface RealtimeEventUpdate {
  userDelta?: string;
  userTranscript?: string;
  assistantDelta?: string;
  speechStarted?: boolean;
  interrupted?: boolean;
  responseDone?: boolean;
  outputTokens?: number;
  error?: string;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function tokens(value: unknown): number | undefined {
  const count = typeof value === "number" ? value : Number(value);
  return Number.isFinite(count) && count >= 0 ? Math.floor(count) : undefined;
}

function usageTokens(event: UnknownRecord): number | undefined {
  const response = isRecord(event.response) ? event.response : undefined;
  const usage = response ? response.usage : event.usage;
  if (!isRecord(usage)) return undefined;
  return (
    tokens(usage.output_tokens) ??
    tokens(usage.outputTokens) ??
    tokens(usage.total_tokens) ??
    tokens(usage.totalTokens)
  );
}

function errorMessage(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  return text(value.message) ?? text(value.description);
}

/**
 * Converts one Realtime data-channel message into UI-level updates. Keeping
 * this pure makes the event contract testable without a browser or media
 * stack, and isolates the rest of the app from provider event naming.
 */
export function parseRealtimeEvent(raw: unknown): RealtimeEventUpdate | null {
  let event = raw;
  if (typeof event === "string") {
    try {
      event = JSON.parse(event);
    } catch {
      return null;
    }
  }
  if (!isRecord(event)) return null;

  switch (event.type) {
    case "conversation.item.input_audio_transcription.delta":
      return text(event.delta)
        ? { userDelta: event.delta as string }
        : null;
    case "conversation.item.input_audio_transcription.completed":
      return text(event.transcript)
        ? { userTranscript: event.transcript as string }
        : null;
    case "conversation.item.input_audio_transcription.failed":
      return {
        error: errorMessage(event.error) ?? "Could not transcribe that audio.",
      };
    case "response.output_text.delta":
    case "response.output_audio_transcript.delta":
      return text(event.delta)
        ? { assistantDelta: event.delta as string }
        : null;
    case "input_audio_buffer.speech_started":
      return { speechStarted: true };
    case "response.interrupted":
      return { interrupted: true };
    case "response.done": {
      const done = usageTokens(event);
      return {
        responseDone: true,
        ...(done === undefined ? {} : { outputTokens: done }),
      };
    }
    case "error":
      return {
        error: errorMessage(event.error) ?? "The Realtime session reported an error.",
      };
    default:
      return null;
  }
}
