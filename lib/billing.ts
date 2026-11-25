import { config } from "./config";
import { AppError } from "./errors";
import type { IdentityContext } from "./identity";
import { stateBackend, type StateDocument, type StoredUsage } from "./state";

/** Illustrative micro-dollar rates; replace with real provider cost tables. */
export interface Plan {
  dailyRequests: number;
  monthlyBaseMicros: number;
  requestMicros: number;
  audioSecondMicros: number;
  outputTokenMicros: number;
}

export const PLANS = {
  free: {
    dailyRequests: 50,
    monthlyBaseMicros: 0,
    requestMicros: 0,
    audioSecondMicros: 0,
    outputTokenMicros: 0,
  },
  pro: {
    dailyRequests: 1_000,
    monthlyBaseMicros: 2_900_000,
    requestMicros: 2_000,
    audioSecondMicros: 400,
    outputTokenMicros: 20,
  },
  enterprise: {
    dailyRequests: 20_000,
    monthlyBaseMicros: 9_900_000,
    requestMicros: 800,
    audioSecondMicros: 150,
    outputTokenMicros: 8,
  },
} as const satisfies Record<string, Plan>;

export type PlanName = keyof typeof PLANS;

export function isPlanName(value: unknown): value is PlanName {
  return typeof value === "string" && value in PLANS;
}

export function utcDate(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

function usageKey(accountId: string, date: string): string {
  return `${accountId}:${date}`;
}

function emptyUsage(accountId: string, date: string): StoredUsage {
  return {
    accountId,
    date,
    requests: 0,
    audioSeconds: 0,
    outputTokens: 0,
    costMicros: 0,
    updatedAt: new Date().toISOString(),
  };
}

function getUsage(
  document: StateDocument,
  accountId: string,
  date: string,
): StoredUsage {
  const key = usageKey(accountId, date);
  document.usage[key] ??= emptyUsage(accountId, date);
  return document.usage[key];
}

function ensureGlobalBudget(document: StateDocument, date: string): void {
  if (document.budget.date !== date) {
    document.budget.date = date;
    document.budget.used = 0;
  }
}

function quotaError(plan: Plan): AppError {
  return new AppError(
    "QUOTA_EXHAUSTED",
    `Your ${plan.dailyRequests}-request daily quota is exhausted. Try again tomorrow or upgrade your plan.`,
    429,
  );
}

/**
 * Atomically reserves one request against both the global spend cap and, when
 * authenticated, the account's daily quota. Nothing is charged for malformed
 * requests because callers invoke this after validation.
 */
export async function consumeRequestBudget(
  route: string,
  identity?: IdentityContext,
): Promise<void> {
  const date = utcDate();
  await stateBackend().write((document) => {
    ensureGlobalBudget(document, date);
    const plan = identity ? PLANS[identity.plan] : undefined;
    const usage = identity ? getUsage(document, identity.accountId, date) : undefined;

    if (document.budget.used >= config.dailyRequestBudget) {
      throw new AppError(
        "BUDGET_EXHAUSTED",
        "The daily request budget has been reached. Please try again tomorrow.",
        429,
      );
    }
    if (plan && usage && usage.requests >= plan.dailyRequests) {
      throw quotaError(plan);
    }

    document.budget.used += 1;
    if (plan && usage) {
      usage.requests += 1;
      usage.costMicros += plan.requestMicros;
      usage.updatedAt = new Date().toISOString();
    }
  });
  void route;
}

/** Returns a failed reservation to both counters. */
export async function releaseRequestBudget(
  route: string,
  identity?: IdentityContext,
): Promise<boolean> {
  const date = utcDate();
  const refunded = await stateBackend().write((document) => {
    ensureGlobalBudget(document, date);
    if (document.budget.used <= 0) return false;
    const plan = identity ? PLANS[identity.plan] : undefined;
    const usage = identity ? document.usage[usageKey(identity.accountId, date)] : undefined;
    if (identity && (!plan || !usage || usage.requests <= 0)) return false;

    document.budget.used -= 1;
    if (plan && usage) {
      usage.requests = Math.max(0, usage.requests - 1);
      usage.costMicros = Math.max(0, usage.costMicros - plan.requestMicros);
      usage.updatedAt = new Date().toISOString();
    }
    return true;
  });
  void route;
  return refunded;
}

/** Adds provider-reported Realtime usage to an open state document. */
export function meterRealtimeUsage(
  document: StateDocument,
  identity: IdentityContext,
  input: { audioSeconds?: number; outputTokens?: number },
): void {
  const date = utcDate();
  const plan = PLANS[identity.plan];
  const usage = getUsage(document, identity.accountId, date);
  const audioSeconds = input.audioSeconds ?? 0;
  const outputTokens = input.outputTokens ?? 0;
  usage.audioSeconds += audioSeconds;
  usage.outputTokens += outputTokens;
  usage.costMicros += Math.round(
    audioSeconds * plan.audioSecondMicros + outputTokens * plan.outputTokenMicros,
  );
  usage.updatedAt = new Date().toISOString();
}

/** Adds provider-reported Realtime usage to the account's meter. */
export async function recordRealtimeMetering(
  identity: IdentityContext,
  input: { audioSeconds?: number; outputTokens?: number },
): Promise<void> {
  await stateBackend().write((document) => meterRealtimeUsage(document, identity, input));
}

export async function usageSnapshot(identity: IdentityContext): Promise<StoredUsage> {
  const date = utcDate();
  return stateBackend().read((document) => {
    const key = usageKey(identity.accountId, date);
    return document.usage[key]
      ? { ...document.usage[key] }
      : emptyUsage(identity.accountId, date);
  });
}

export async function quotaSnapshot(identity: IdentityContext): Promise<{
  date: string;
  used: number;
  limit: number;
  remaining: number;
}> {
  const plan = PLANS[identity.plan];
  const usage = await usageSnapshot(identity);
  return {
    date: usage.date,
    used: usage.requests,
    limit: plan.dailyRequests,
    remaining: Math.max(0, plan.dailyRequests - usage.requests),
  };
}

export interface UsageReport {
  rows: StoredUsage[];
  totals: {
    requests: number;
    audioSeconds: number;
    outputTokens: number;
    costMicros: number;
  };
}

/** All account usage rows plus totals, newest first. */
export async function usageReport(): Promise<UsageReport> {
  return stateBackend().read((document) => {
    const rows = Object.values(document.usage)
      .map((row) => ({ ...row }))
      .sort((left, right) =>
        left.date === right.date
          ? left.accountId.localeCompare(right.accountId)
          : right.date.localeCompare(left.date),
      );
    return {
      rows,
      totals: rows.reduce(
        (total, row) => ({
          requests: total.requests + row.requests,
          audioSeconds: total.audioSeconds + row.audioSeconds,
          outputTokens: total.outputTokens + row.outputTokens,
          costMicros: total.costMicros + row.costMicros,
        }),
        { requests: 0, audioSeconds: 0, outputTokens: 0, costMicros: 0 },
      ),
    };
  });
}

export interface BillingLine {
  accountId: string;
  plan: PlanName;
  baseMicros: number;
  requestMicros: number;
  usageMicros: number;
  totalMicros: number;
  requests: number;
  audioSeconds: number;
  outputTokens: number;
}

/** Aggregates all stored usage rows into an invoice-style view. */
export async function billingReport(): Promise<BillingLine[]> {
  return stateBackend().read((document) => {
    const accounts = Object.values(document.accounts);
    const byAccount = new Map<string, BillingLine>();

    const lineFor = (accountId: string, plan: PlanName): BillingLine => {
      let line = byAccount.get(accountId);
      if (!line) {
        line = {
          accountId,
          plan,
          baseMicros: PLANS[plan].monthlyBaseMicros,
          requestMicros: 0,
          usageMicros: 0,
          totalMicros: PLANS[plan].monthlyBaseMicros,
          requests: 0,
          audioSeconds: 0,
          outputTokens: 0,
        };
        byAccount.set(accountId, line);
      }
      return line;
    };

    for (const account of accounts) {
      lineFor(account.id, account.plan);
    }
    for (const usage of Object.values(document.usage)) {
      const account = accounts.find((item) => item.id === usage.accountId);
      if (!account) continue;
      const plan = PLANS[account.plan];
      const line = lineFor(account.id, account.plan);
      const requestMicros = usage.requests * plan.requestMicros;
      const realtimeMicros = Math.round(
        usage.audioSeconds * plan.audioSecondMicros +
          usage.outputTokens * plan.outputTokenMicros,
      );
      line.requests += usage.requests;
      line.audioSeconds += usage.audioSeconds;
      line.outputTokens += usage.outputTokens;
      line.requestMicros += requestMicros;
      line.usageMicros += realtimeMicros;
    }

    const result = [...byAccount.values()];
    for (const line of result) {
      line.totalMicros = line.baseMicros + line.requestMicros + line.usageMicros;
    }
    return result;
  });
}
