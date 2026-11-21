"use client";

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export interface StreamWorkflow {
  workflow: unknown;
  appointments: unknown;
}

export interface StreamHandlers {
  onSession?: (sessionId: string) => void;
  onTranscript?: (transcript: string) => void;
  onDelta?: (text: string) => void;
  onAudio?: (index: number, audio: string) => void;
  onWorkflow?: (payload: StreamWorkflow) => void;
  onDone?: () => void;
}

export async function errorFromResponse(response: Response): Promise<ApiError> {
  const data = (await response.json().catch(() => null)) as {
    detail?: { message?: string; error_code?: string };
  } | null;
  return new ApiError(
    response.status,
    data?.detail?.message || "The request failed. Please try again.",
  );
}

/**
 * Incremental SSE parser. Frames are dispatched as soon as they arrive, so
 * text and audio can render while the model is still writing.
 */
export async function consumeSse(
  response: Response,
  handlers: StreamHandlers,
): Promise<void> {
  if (!response.body) {
    throw new ApiError(502, "The server returned an empty stream.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        dispatch(frame, handlers);
        boundary = buffer.indexOf("\n\n");
      }
    }

    buffer += decoder.decode();
    if (buffer.trim()) dispatch(buffer, handlers);
  } catch (err) {
    await reader.cancel().catch(() => undefined);
    throw err;
  } finally {
    reader.releaseLock();
  }
}

function dispatch(frame: string, handlers: StreamHandlers): void {
  let event = "message";
  const dataLines: string[] = [];

  for (const line of frame.split("\n")) {
    if (line.startsWith(":")) continue;
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }

  if (dataLines.length === 0) return;

  let data: unknown;
  try {
    data = JSON.parse(dataLines.join("\n"));
  } catch {
    return;
  }

  const payload = data as Record<string, unknown>;

  switch (event) {
    case "session":
      if (typeof payload.session_id === "string") {
        handlers.onSession?.(payload.session_id);
      }
      break;
    case "transcript":
      if (typeof payload.transcript === "string") {
        handlers.onTranscript?.(payload.transcript);
      }
      break;
    case "delta":
      if (typeof payload.text === "string") handlers.onDelta?.(payload.text);
      break;
    case "audio":
      if (
        typeof payload.index === "number" &&
        typeof payload.audio === "string"
      ) {
        handlers.onAudio?.(payload.index, payload.audio);
      }
      break;
    case "workflow":
      handlers.onWorkflow?.({
        workflow: payload.workflow ?? null,
        appointments: payload.appointments ?? [],
      });
      break;
    case "done":
      handlers.onDone?.();
      break;
    case "error":
      throw new ApiError(
        502,
        typeof payload.message === "string"
          ? payload.message
          : "The response stream failed. Please try again.",
      );
  }
}
