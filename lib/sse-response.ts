import type { NextRequest } from "next/server";
import { config } from "./config";
import { AppError } from "./errors";
import { errorMessage, logError } from "./logger";
import { encodeSse, encodeSseComment, sseHeaders } from "./sse";

const GENERIC_STREAM_MESSAGE =
  "The stream hit an unexpected error. Please try again.";

export interface SseOptions {
  requestId: string;
  headers?: Record<string, string>;
  /** Keep-alive comment cadence. Defaults to SSE_HEARTBEAT_MS. */
  heartbeatMs?: number;
  /** Hard limit for one streamed turn. Defaults to TURN_TIMEOUT_MS. */
  timeoutMs?: number;
  run: (
    send: (event: string, data: unknown) => void,
    signal: AbortSignal,
  ) => Promise<void>;
}

/**
 * Wraps a streaming task in an SSE response. Upstream failures before the
 * first byte are ordinary JSON errors; failures after the stream starts are
 * emitted as an `error` event so the client can recover cleanly.
 *
 * Two timers protect the connection: a periodic comment keeps proxies from
 * treating a quiet stream as dead, and a hard deadline aborts a turn that
 * would otherwise pin a session lock forever.
 */
export function sseResponse(request: NextRequest, options: SseOptions): Response {
  const abortController = new AbortController();
  const onAbort = () => abortController.abort();
  request.signal.addEventListener("abort", onAbort, { once: true });

  const heartbeatMs = options.heartbeatMs ?? config.sseHeartbeatMs;
  const timeoutMs = options.timeoutMs ?? config.turnTimeoutMs;

  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      let deadline: ReturnType<typeof setTimeout> | undefined;

      const sendRaw = (frame: Uint8Array): void => {
        if (closed) return;
        try {
          controller.enqueue(frame);
        } catch {
          closed = true;
          abortController.abort();
        }
      };

      const send = (event: string, data: unknown): void => {
        sendRaw(encodeSse(event, data));
      };

      try {
        heartbeat = setInterval(
          () => sendRaw(encodeSseComment("ping")),
          heartbeatMs,
        );

        const timeout = new Promise<never>((_, reject) => {
          deadline = setTimeout(() => {
            abortController.abort();
            reject(
              new AppError(
                "TURN_TIMEOUT",
                `The turn exceeded ${Math.round(timeoutMs / 1000)}s. Please try a shorter question.`,
                504,
              ),
            );
          }, timeoutMs);
        });

        await Promise.race([options.run(send, abortController.signal), timeout]);
      } catch (err) {
        const timedOut = err instanceof AppError && err.code === "TURN_TIMEOUT";

        if (timedOut) {
          const payload = streamError(err, options.requestId);
          logError("stream.timed_out", {
            requestId: options.requestId,
            message: err.message,
          });
          send("error", payload);
        } else if (!abortController.signal.aborted) {
          const payload = streamError(err, options.requestId);
          logError("stream.failed", {
            requestId: options.requestId,
            code: payload.error_code,
            message: err instanceof AppError ? err.message : errorMessage(err),
          });
          send("error", payload);
        }

        // Stop any background speech work still queued for this turn.
        if (!abortController.signal.aborted) abortController.abort();
      } finally {
        if (heartbeat !== undefined) clearInterval(heartbeat);
        if (deadline !== undefined) clearTimeout(deadline);
        closed = true;
        request.signal.removeEventListener("abort", onAbort);
        try {
          controller.close();
        } catch {
          // The client already closed the stream.
        }
      }
    },
    cancel() {
      abortController.abort();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      ...sseHeaders(),
      "x-request-id": options.requestId,
      ...options.headers,
    },
  });
}

function streamError(
  err: unknown,
  requestId: string,
): { error_code: string; message: string; request_id: string } {
  if (!(err instanceof AppError)) {
    return {
      error_code: "INTERNAL",
      message: GENERIC_STREAM_MESSAGE,
      request_id: requestId,
    };
  }

  return {
    error_code: err.code,
    message:
      err.code === "TURN_TIMEOUT" ||
      !(config.isProduction && err.status >= 500)
        ? err.message
        : GENERIC_STREAM_MESSAGE,
    request_id: requestId,
  };
}
