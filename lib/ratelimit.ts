import { config } from "./config";

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();
let operations = 0;

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
  retryAfterSeconds: number;
}

function sweep(now: number): void {
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

/**
 * Fixed-window in-memory limiter. Good for a single-instance deployment
 * (Docker/Render/Fly). For multi-instance serverless, swap this module for a
 * shared store (Upstash Redis, etc.).
 */
export function rateLimit(key: string): RateLimitResult {
  const now = Date.now();
  operations += 1;
  if (operations % 100 === 0) sweep(now);

  let bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + config.rateLimitWindowMs };
    buckets.set(key, bucket);
  }
  bucket.count += 1;

  return {
    allowed: bucket.count <= config.rateLimitRequests,
    limit: config.rateLimitRequests,
    remaining: Math.max(0, config.rateLimitRequests - bucket.count),
    resetAt: bucket.resetAt,
    retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
  };
}

let budgetDate = "";
let budgetUsed = 0;

/** Global (per-process) daily AI request budget — a blunt spend cap. */
export function consumeDailyBudget(): boolean {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== budgetDate) {
    budgetDate = today;
    budgetUsed = 0;
  }
  if (budgetUsed >= config.dailyRequestBudget) return false;
  budgetUsed += 1;
  return true;
}

export function budgetSnapshot(): { date: string; used: number; limit: number } {
  return {
    date: budgetDate || new Date().toISOString().slice(0, 10),
    used: budgetUsed,
    limit: config.dailyRequestBudget,
  };
}
