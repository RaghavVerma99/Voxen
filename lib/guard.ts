import { timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { config } from "./config";
import { AppError } from "./errors";
import { logEvent } from "./logger";
import { consumeDailyBudget, rateLimit } from "./ratelimit";

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function clientAddress(request: NextRequest): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return request.headers.get("x-real-ip")?.trim() || "local";
}

/** Optional shared access code for private previews. No-op when unset. */
export function requireAccess(request: NextRequest): void {
  if (!config.accessCode) return;
  const provided = request.headers.get("x-access-code") ?? "";
  if (!safeEqual(provided, config.accessCode)) {
    throw new AppError("ACCESS_DENIED", "Invalid or missing access code", 401);
  }
}

/**
 * Applies access control and per-client rate limiting. Throws a typed
 * AppError the route maps to a response.
 */
export function guardRequest(request: NextRequest, route: string): void {
  requireAccess(request);

  const result = rateLimit(`${clientAddress(request)}:${route}`);
  if (!result.allowed) {
    logEvent("request.rate_limited", { route, retryAfterSeconds: result.retryAfterSeconds });
    throw new AppError(
      "RATE_LIMITED",
      `Too many requests. Try again in ${result.retryAfterSeconds}s.`,
      429,
    );
  }
}

/**
 * Counts one paid AI request against the daily budget. Call this after the
 * request has been validated, so malformed input does not burn budget.
 */
export function consumeBudget(route: string): void {
  if (!consumeDailyBudget()) {
    logEvent("request.budget_exhausted", { route });
    throw new AppError(
      "BUDGET_EXHAUSTED",
      "The daily request budget has been reached. Please try again tomorrow.",
      429,
    );
  }
}
