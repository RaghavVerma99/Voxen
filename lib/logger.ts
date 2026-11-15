import { createHash } from "node:crypto";

type LogFields = Record<string, unknown>;

/**
 * Session ids are bearer tokens for their conversation. Log a stable hash
 * instead of the real value so log drains cannot be used to read transcripts.
 */
export function redactSessionId(sessionId: string): string {
  return `sha256:${createHash("sha256").update(sessionId).digest("hex").slice(0, 12)}`;
}

function emit(level: "info" | "warn" | "error", event: string, fields: LogFields): void {
  // Keep test output clean; production logs are structured JSON for log drains.
  if (process.env.NODE_ENV === "test") return;
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    event,
    ...fields,
  });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export function logEvent(event: string, fields: LogFields = {}): void {
  emit("info", event, fields);
}

export function logWarning(event: string, fields: LogFields = {}): void {
  emit("warn", event, fields);
}

export function logError(event: string, fields: LogFields = {}): void {
  emit("error", event, fields);
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
