import { config } from "./config";
import { stateBackend } from "./state";

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
  retryAfterSeconds: number;
}

/**
 * Fixed-window limiter backed by the configured state adapter. The default
 * memory backend is per process; `STATE_BACKEND=file` makes this cap shared by
 * every instance using the same state file.
 */
export function rateLimit(key: string): RateLimitResult {
  return stateBackend().write((document) => {
    const now = Date.now();
    document.rateOperations += 1;
    if (document.rateOperations % 100 === 0) {
      for (const [bucketKey, bucket] of Object.entries(document.rate)) {
        if (bucket.resetAt <= now) delete document.rate[bucketKey];
      }
    }

    let bucket = document.rate[key];
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + config.rateLimitWindowMs };
      document.rate[key] = bucket;
    }
    bucket.count += 1;

    return {
      allowed: bucket.count <= config.rateLimitRequests,
      limit: config.rateLimitRequests,
      remaining: Math.max(0, config.rateLimitRequests - bucket.count),
      resetAt: bucket.resetAt,
      retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1_000)),
    };
  });
}

/** Global daily AI request budget — a blunt spend cap. */
export function consumeDailyBudget(): boolean {
  return stateBackend().write((document) => {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== document.budget.date) {
      document.budget.date = today;
      document.budget.used = 0;
    }
    if (document.budget.used >= config.dailyRequestBudget) return false;
    document.budget.used += 1;
    return true;
  });
}

/**
 * Returns one reserved request to the budget. Call this when a turn fails
 * before producing a useful result (for example, STT rejects the audio).
 */
export function refundDailyBudget(): boolean {
  return stateBackend().write((document) => {
    if (document.budget.used <= 0) return false;
    document.budget.used -= 1;
    return true;
  });
}

export function budgetSnapshot(): { date: string; used: number; limit: number } {
  return stateBackend().read((document) => ({
    date: document.budget.date || new Date().toISOString().slice(0, 10),
    used: document.budget.used,
    limit: config.dailyRequestBudget,
  }));
}
