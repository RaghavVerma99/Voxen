import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  billingReport,
  consumeRequestBudget,
  PLANS,
  quotaSnapshot,
  recordRealtimeMetering,
  releaseRequestBudget,
  usageSnapshot,
} from "@/lib/billing";
import { config } from "@/lib/config";
import { createAccount, type IdentityContext } from "@/lib/identity";
import { recordRealtimeUsage } from "@/lib/realtime-budget";
import {
  createMemoryStateBackend,
  stateBackend,
  useStateBackendForTests,
} from "@/lib/state";

function identity(plan: "free" | "pro" | "enterprise" = "free"): IdentityContext {
  return { accountId: `account-${plan}`, plan, role: "user" };
}

describe("per-account quotas and metering", () => {
  const originalBudget = config.dailyRequestBudget;
  const originalSecret = config.identitySecret;

  beforeEach(() => {
    useStateBackendForTests(createMemoryStateBackend());
    config.dailyRequestBudget = 10_000;
    config.identitySecret = "test-identity-secret-1234";
  });

  afterEach(() => {
    config.dailyRequestBudget = originalBudget;
    config.identitySecret = originalSecret;
  });

  it("charges the global budget and the account meter together", () => {
    const account = identity("pro");
    consumeRequestBudget("chat", account);

    expect(stateBackend().read((document) => document.budget.used)).toBe(1);
    expect(usageSnapshot(account)).toMatchObject({
      requests: 1,
      costMicros: PLANS.pro.requestMicros,
    });
    expect(quotaSnapshot(account)).toMatchObject({ used: 1, limit: 1_000 });
  });

  it("refuses an exhausted account quota before doing paid work", () => {
    const account = identity("free");
    for (let index = 0; index < PLANS.free.dailyRequests; index += 1) {
      consumeRequestBudget("chat", account);
    }

    expect(() => consumeRequestBudget("chat", account)).toThrowError(
      expect.objectContaining({ code: "QUOTA_EXHAUSTED", status: 429 }),
    );
    expect(stateBackend().read((document) => document.budget.used)).toBe(
      PLANS.free.dailyRequests,
    );
  });

  it("refunds both counters when a request fails", () => {
    const account = identity("pro");
    consumeRequestBudget("chat", account);
    expect(releaseRequestBudget("chat", account)).toBe(true);

    expect(stateBackend().read((document) => document.budget.used)).toBe(0);
    expect(usageSnapshot(account).requests).toBe(0);
    expect(usageSnapshot(account).costMicros).toBe(0);
  });

  it("does not refund more than was reserved", () => {
    const account = identity("free");
    expect(releaseRequestBudget("chat", account)).toBe(false);
    expect(stateBackend().read((document) => document.budget.used)).toBe(0);
  });

  it("meters Realtime audio and output tokens", () => {
    const account = identity("enterprise");
    consumeRequestBudget("realtime-token", account);
    recordRealtimeMetering(account, { audioSeconds: 10, outputTokens: 100 });

    expect(usageSnapshot(account)).toMatchObject({
      audioSeconds: 10,
      outputTokens: 100,
      costMicros:
        PLANS.enterprise.requestMicros +
        10 * PLANS.enterprise.audioSecondMicros +
        100 * PLANS.enterprise.outputTokenMicros,
    });
  });

  it("records session usage and the account meter in one write", () => {
    const account = identity("pro");
    recordRealtimeUsage("live-session", { audioSeconds: 4, outputTokens: 25 }, account);

    expect(stateBackend().read((document) => document.realtime["live-session"])).toMatchObject({
      audioSeconds: 4,
      outputTokens: 25,
    });
    expect(usageSnapshot(account)).toMatchObject({
      audioSeconds: 4,
      outputTokens: 25,
      costMicros: 4 * PLANS.pro.audioSecondMicros + 25 * PLANS.pro.outputTokenMicros,
    });
  });

  it("builds an invoice-style report for provisioned accounts", () => {
    const { account } = createAccount({ name: "Ada", plan: "pro" });
    const context: IdentityContext = {
      accountId: account.id,
      plan: account.plan,
      role: account.role,
    };
    consumeRequestBudget("chat", context);
    recordRealtimeMetering(context, { audioSeconds: 5, outputTokens: 20 });

    const [line] = billingReport();
    expect(line).toMatchObject({
      accountId: account.id,
      plan: "pro",
      requests: 1,
      audioSeconds: 5,
      outputTokens: 20,
      baseMicros: PLANS.pro.monthlyBaseMicros,
      requestMicros: PLANS.pro.requestMicros,
      usageMicros:
        5 * PLANS.pro.audioSecondMicros + 20 * PLANS.pro.outputTokenMicros,
    });
    expect(line.totalMicros).toBe(
      line.baseMicros + line.requestMicros + line.usageMicros,
    );
  });
});
