import WebSocket from "ws";
import { config } from "./config";
import { AppError } from "./errors";
import { errorMessage } from "./logger";

const REALTIME_ENDPOINT = "wss://api.openai.com/v1/realtime";
const REALTIME_OUTPUT_FORMAT = { type: "audio/pcm", rate: 24000 };

interface RealtimeEvent {
  type?: string;
  delta?: string;
  response?: { status?: string } & Record<string, unknown>;
}

function toAbortError(): Error {
  const err = new Error("The speech request was cancelled.");
  err.name = "AbortError";
  return err;
}

function pcmToWav(pcm: Buffer): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(24000, 24);
  header.writeUInt32LE(24000 * 2, 28);
  header.writeUInt16LE(16, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/**
 * Narration through the Realtime API (`gpt-realtime-2.1-mini`). The deprecated
 * Speech API shuts down on January 6, 2027, so sentence-level TTS now runs as a
 * Realtime response: the text becomes an input message and the model streams
 * base64 PCM audio back, which is wrapped in a WAV container for playback.
 */
export async function synthesizeSpeechRealtime(
  text: string,
  signal?: AbortSignal,
): Promise<string> {
  const controller = new AbortController();
  const client = new WebSocket(
    `${REALTIME_ENDPOINT}?model=${encodeURIComponent(config.realtimeTtsModel)}`,
    { headers: { Authorization: `Bearer ${config.openaiApiKey}` } },
  );
  const abortFromExternal = (): void => {
    controller.abort();
    try {
      client.close();
    } catch {
      // The socket may already be closed during teardown.
    }
  };
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", abortFromExternal, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), config.openaiTimeoutMs);

  let settled = false;
  let audioBase64 = "";
  let sessionReady = false;

  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => {
        settle(new AppError("TTS_FAILED", errorMessage(err), 502));
      };
      const onClose = (code: number, reason?: unknown): void => {
        settle(
          new AppError(
            "TTS_FAILED",
            `Realtime session closed before speech finished (code ${code}).`,
            502,
          ),
        );
      };
      const onMessage = (data: unknown): void => {
        let event: RealtimeEvent;
        try {
          const payload =
            typeof data === "string"
              ? data
              : Buffer.from(data as Buffer).toString("utf8");
          event = JSON.parse(payload) as RealtimeEvent;
        } catch {
          return;
        }

        if (event.type === "session.created") {
          if (sessionReady) return;
          sessionReady = true;
          client.send(
            JSON.stringify({
              type: "session.update",
              session: {
                type: "realtime",
                instructions: config.realtimeTtsInstructions,
                output_modalities: ["audio"],
                audio: {
                  input: { format: REALTIME_OUTPUT_FORMAT, turn_detection: null },
                  output: { format: REALTIME_OUTPUT_FORMAT, voice: config.realtimeTtsVoice },
                },
              },
            }),
          );
          client.send(
            JSON.stringify({
              type: "conversation.item.create",
              item: {
                type: "message",
                role: "user",
                content: [{ type: "input_text", text }],
              },
            }),
          );
          client.send(
            JSON.stringify({
              type: "response.create",
              response: { output_modalities: ["audio"] },
            }),
          );
          return;
        }

        if (event.type === "response.output_audio.delta" && typeof event.delta === "string") {
          audioBase64 += event.delta;
          return;
        }

        if (event.type === "response.done") {
          const status = event.response?.status;
          if (status && status !== "completed") {
            settle(new AppError("TTS_FAILED", `Realtime response ${status}`, 502));
            return;
          }
          settle();
        }
      };
      const cleanup = (): void => {
        client.off("error", onError);
        client.off("message", onMessage);
        client.off("close", onClose);
      };
      const settle = (err?: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        if (err) reject(err);
        else resolve();
      };

      client.on("error", onError);
      client.on("close", onClose);
      client.on("message", onMessage);
    });

    if (controller.signal.aborted) throw toAbortError();

    const wav = pcmToWav(Buffer.from(audioBase64, "base64"));
    return wav.toString("base64");
  } catch (err) {
    if (controller.signal.aborted) throw toAbortError();
    throw new AppError("TTS_FAILED", errorMessage(err), 502);
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", abortFromExternal);
    try {
      client.close();
    } catch {
      // The socket may already be closed during teardown.
    }
  }
}
