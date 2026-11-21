export type ErrorCode =
  | "INTERNAL"
  | "CONFIG_ERROR"
  | "ACCESS_DENIED"
  | "RATE_LIMITED"
  | "BUDGET_EXHAUSTED"
  | "INVALID_BODY"
  | "PAYLOAD_TOO_LARGE"
  | "EMPTY_MESSAGE"
  | "MESSAGE_TOO_LONG"
  | "MISSING_SESSION"
  | "INVALID_SESSION"
  | "EMPTY_AUDIO"
  | "AUDIO_TOO_LARGE"
  | "AUDIO_TOO_LONG"
  | "INVALID_AUDIO_DURATION"
  | "NOTHING_HEARD"
  | "NOT_FOUND"
  | "STT_FAILED"
  | "LLM_FAILED"
  | "TTS_FAILED"
  | "TURN_TIMEOUT";

export type ErrorHeaders = Record<string, string>;

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly headers?: ErrorHeaders;

  constructor(
    code: ErrorCode,
    message: string,
    status = 400,
    headers?: ErrorHeaders,
  ) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = status;
    this.headers = headers;
  }
}
