import { timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import {
  consumeRequestBudget,
  releaseRequestBudget,
} from "./billing";
import { config, isProductionAccessMisconfigured } from "./config";
import { AppError } from "./errors";
import { identityFromRequest, type IdentityContext } from "./identity";
import { logEvent } from "./logger";
import {
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

export interface GuardResult extends RateLimitResult {
  identity: IdentityContext | null;
}

/**
 * Applies per-identity/per-client rate limiting and access control. Rate
 * limiting runs first so denied access-code attempts are still counted and
 * cannot be brute-forced without a bound. In production, a missing or too-short
 * access code fails closed before any paid work can start.
 */
export async function guardRequest(
  request: NextRequest,
  route: string,
): Promise<GuardResult> {
  let identity: IdentityContext | null = null;
  let identityError: unknown;
  try {
    identity = await identityFromRequest(request);
  } catch (err) {
    // Count invalid-key attempts first, then surface the auth error after the
    // rate-limit decision so they cannot bypass the shared bucket.
    identityError = err;
  }

  const subject = identity ? `account:${identity.accountId}` : clientAddress(request);
  const result = await rateLimit(`${subject}:${route}`);
  const guarded: GuardResult = { ...result, identity };

  if (!result.allowed) {
    logEvent("request.rate_limited", {
      route,
      subject: identity ? "account" : "client",
      retryAfterSeconds: result.retryAfterSeconds,
    });
    throw new AppError(
      "RATE_LIMITED",
      `Too many requests. Try again in ${result.retryAfterSeconds}s.`,
      429,
      rateLimitHeaders(result, true),
    );
  }

  if (identityError) throw identityError;

  if (isProductionAccessMisconfigured()) {
    logEvent("request.access_misconfigured", { route });
    throw new AppError(
      "CONFIG_ERROR",
      `ACCESS_CODE must be set to at least ${config.minAccessCodeLength} characters in production.`,
      503,
      rateLimitHeaders(result),
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

  return guarded;
}

/**
 * Counts one paid AI request against the global budget and the caller's plan.
 * Call this after the request has been validated, so malformed input does not
 * burn budget.
 */
export async function consumeBudget(
  route: string,
  identity?: IdentityContext | null,
): Promise<void> {
  try {
    await consumeRequestBudget(route, identity ?? undefined);
  } catch (err) {
    if (err instanceof AppError && err.code === "QUOTA_EXHAUSTED") {
      logEvent("request.quota_exhausted", { route });
    } else {
      logEvent("request.budget_exhausted", { route });
    }
    throw err;
  }
}

/** Releases a reservation made by consumeBudget when the turn fails. */
export async function releaseBudget(
  route: string,
  identity?: IdentityContext | null,
): Promise<void> {
  if (await releaseRequestBudget(route, identity ?? undefined)) return;
  logEvent("request.budget_released", { route });
}
