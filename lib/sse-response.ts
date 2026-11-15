import type { NextRequest } from "next/server";
import { config } from "./config";
import { AppError } from "./errors";
import { errorMessage, logError } from "./logger";
import { encodeSse, sseHeaders } from "./sse";

const GENERIC_STREAM_MESSAGE =
  "The stream hit an unexpected error. Please try again.";

export interface SseOptions {
  requestId: string;
  headers?: Record<string, string>;
  run: (
    send: (event: string, data: unknown) => void,
    signal: AbortSignal,
  ) => Promise<void>;
}

/**
 * Wraps a streaming task in an SSE response. Upstream failures before the
 * first byte are ordinary JSON errors; failures after the stream starts are
 * emitted as an `error` event so the client can recover cleanly.
 */
export function sseResponse(request: NextRequest, options: SseOptions): Response {
  const abortController = new AbortController();
  const onAbort = () => abortController.abort();
  request.signal.addEventListener("abort", onAbort, { once: true });

  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown): void => {
        if (closed) return;
        try {
          controller.enqueue(encodeSse(event, data));
        } catch {
          closed = true;
          abortController.abort();
        }
      };

      try {
        await options.run(send, abortController.signal);
      } catch (err) {
        if (!abortController.signal.aborted) {
          const payload = streamError(err, options.requestId);
          logError("stream.failed", {
            requestId: options.requestId,
            code: payload.error_code,
            message: err instanceof AppError ? err.message : errorMessage(err),
          });
          send("error", payload);
        }
      } finally {
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
      config.isProduction && err.status >= 500
        ? GENERIC_STREAM_MESSAGE
        : err.message,
    request_id: requestId,
  };
}
