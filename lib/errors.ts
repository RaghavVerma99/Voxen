export type ErrorCode =
  | "INTERNAL"
  | "EMPTY_MESSAGE"
  | "MISSING_SESSION"
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