export type ErrorCode =
  | "INTERNAL"
  | "CONFIG_ERROR"
  | "ACCESS_DENIED"
  | "RATE_LIMITED"
  | "BUDGET_EXHAUSTED"
  | "EMPTY_MESSAGE"
  | "MESSAGE_TOO_LONG"
  | "MISSING_SESSION"
  | "INVALID_SESSION"
  | "EMPTY_AUDIO"
  | "AUDIO_TOO_LARGE"
  | "AUDIO_TOO_LONG"
  | "NOTHING_HEARD"
  | "STT_FAILED"
  | "LLM_FAILED"
  | "TTS_FAILED";

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;

  constructor(code: ErrorCode, message: string, status = 400) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = status;
  }
}
