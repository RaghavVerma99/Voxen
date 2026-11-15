import { timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { config } from "./config";
import { AppError } from "./errors";
import { logEvent } from "./logger";
import {
  consumeDailyBudget,
  rateLimit,
  type RateLimitResult,
} from "./ratelimit";

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Resolves the client address. Forwarded headers are only trusted when the
 * deployment declares how many proxies sit in front of the app; otherwise a
 * direct client could forge X-Forwarded-For and bypass rate limits.
 */
export function clientAddress(request: NextRequest): string {
  const hops = Math.max(0, Math.floor(config.trustProxyHops));
  if (hops > 0) {
    const forwarded = request.headers.get("x-forwarded-for");
    if (forwarded) {
      const parts = forwarded
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean);
      const candidate = parts[parts.length - hops] ?? parts[parts.length - 1];
      if (candidate) return candidate;
    }

    const realIp = request.headers.get("x-real-ip")?.trim();
    if (realIp) return realIp;
  }

  return "local";
}

/** Optional shared access code for private previews. No-op when unset. */
export function requireAccess(request: NextRequest): void {
  if (!config.accessCode) return;
  const provided = request.headers.get("x-access-code") ?? "";
  if (!safeEqual(provided, config.accessCode)) {
    throw new AppError("ACCESS_DENIED", "Invalid or missing access code", 401);
  }
}

export function rateLimitHeaders(
  result: RateLimitResult,
  retryAfter = false,
): Record<string, string> {
  return {
    "RateLimit-Limit": String(result.limit),
    "RateLimit-Remaining": String(result.remaining),
    "RateLimit-Reset": String(result.retryAfterSeconds),
    ...(retryAfter ? { "Retry-After": String(result.retryAfterSeconds) } : {}),
  };
}

/**
 * Applies per-client rate limiting and access control. Rate limiting runs
 * first so denied access-code attempts are still counted and cannot be
 * brute-forced without a bound.
 */
export function guardRequest(
  request: NextRequest,
  route: string,
): RateLimitResult {
  const result = rateLimit(`${clientAddress(request)}:${route}`);
  if (!result.allowed) {
    logEvent("request.rate_limited", {
      route,
      retryAfterSeconds: result.retryAfterSeconds,
    });
    throw new AppError(
      "RATE_LIMITED",
      `Too many requests. Try again in ${result.retryAfterSeconds}s.`,
      429,
      rateLimitHeaders(result, true),
    );
  }

  try {
    requireAccess(request);
  } catch (err) {
    if (err instanceof AppError) {
      throw new AppError(err.code, err.message, err.status, rateLimitHeaders(result));
    }
    throw err;
  }

  return result;
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
