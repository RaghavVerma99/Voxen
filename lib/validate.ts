import { randomUUID } from "node:crypto";
import { AppError } from "./errors";

const SESSION_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Resolves a client-supplied session id, creating one when absent.
 * Session ids are effectively bearer tokens for their conversation, so we
 * reject anything outside a conservative, URL-safe character set.
 */
export function resolveSessionId(raw: unknown): string {
  if (raw === undefined || raw === null) return randomUUID();
  const value = String(raw).trim();
  if (value === "") return randomUUID();
  if (!SESSION_PATTERN.test(value)) {
    throw new AppError(
      "INVALID_SESSION",
      "Invalid session_id. Use 1-128 letters, numbers, dashes, or underscores.",
      400,
    );
  }
  return value;
}

/** Same as resolveSessionId, but a session id is mandatory (used by /api/reset). */
export function requireSessionId(raw: unknown): string {
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    throw new AppError("MISSING_SESSION", "session_id is required", 400);
  }
  return resolveSessionId(raw);
}
