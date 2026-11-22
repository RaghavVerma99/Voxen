import { NextRequest } from "next/server";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GET as getAccount } from "@/app/api/account/route";
import { GET as getBilling } from "@/app/api/admin/billing/route";
import {
  GET as getAccounts,
  PATCH as patchAccount,
  POST as postAccount,
} from "@/app/api/admin/accounts/route";
import { GET as getUsage } from "@/app/api/admin/usage/route";
import { config } from "@/lib/config";
import { createMemoryStateBackend, useStateBackendForTests } from "@/lib/state";

function request(
  path: string,
  options: { admin?: boolean; apiKey?: string; method?: string; body?: unknown } = {},
): NextRequest {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (options.admin) headers["x-admin-key"] = config.adminApiKey;
  if (options.apiKey) headers["x-api-key"] = options.apiKey;
  return new NextRequest(`http://localhost${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

describe("admin and account routes", () => {
  const original = {
    adminKey: config.adminApiKey,
    accessCode: config.accessCode,
    identitySecret: config.identitySecret,
    identityRequired: config.identityRequired,
  };

  beforeEach(() => {
    useStateBackendForTests(createMemoryStateBackend());
    config.adminApiKey = "test-admin-key-12345678";
    config.accessCode = "";
    config.identitySecret = "test-identity-secret-1234";
    config.identityRequired = false;
  });

  afterEach(() => {
    Object.assign(config, original);
  });

  it("requires admin access for account and report routes", async () => {
    for (const handler of [getAccounts, getUsage, getBilling]) {
      const response = await handler(request("/api/admin"));
      expect(response.status).toBe(403);
      expect((await response.json()).detail.error_code).toBe("ADMIN_REQUIRED");
    }
  });

  it("keeps the bootstrap admin key valid when identity is required", async () => {
    config.identityRequired = true;
    config.identitySecret = "";

    const response = await getAccounts(
      request("/api/admin/accounts", { admin: true }),
    );
    expect(response.status).toBe(200);
    expect((await response.json()).accounts).toEqual([]);
  });

  it("creates, lists, and updates accounts through the admin route", async () => {
    const createdResponse = await postAccount(
      request("/api/admin/accounts", {
        admin: true,
        method: "POST",
        body: { name: "Ada", email: "ada@example.com", plan: "pro" },
      }),
    );
    expect(createdResponse.status).toBe(201);
    const created = (await createdResponse.json()) as {
      account: { id: string; plan: string; status: string };
      apiKey: string;
    };
    expect(created.apiKey).toMatch(/^vk_/);
    expect(created.account).toMatchObject({ plan: "pro", status: "active" });

    const listResponse = await getAccounts(request("/api/admin/accounts", { admin: true }));
    const list = (await listResponse.json()) as { accounts: Array<{ id: string }> };
    expect(list.accounts.map((account) => account.id)).toContain(created.account.id);

    const patchResponse = await patchAccount(
      request("/api/admin/accounts", {
        admin: true,
        method: "PATCH",
        body: { id: created.account.id, plan: "enterprise", status: "disabled" },
      }),
    );
    expect(patchResponse.status).toBe(200);
    expect((await patchResponse.json()).account).toMatchObject({
      plan: "enterprise",
      status: "disabled",
    });
  });

  it("exposes quota and usage to the account owner", async () => {
    const createdResponse = await postAccount(
      request("/api/admin/accounts", {
        admin: true,
        method: "POST",
        body: { name: "Grace", plan: "pro" },
      }),
    );
    const { apiKey } = (await createdResponse.json()) as { apiKey: string };

    const response = await getAccount(request("/api/account", { apiKey }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      plan: "pro",
      role: "user",
      quota: { limit: 1_000, used: 0 },
      usage: { requests: 0 },
    });
    expect(body.account).not.toHaveProperty("keyHash");
  });

  it("returns admin usage and billing reports", async () => {
    const usageResponse = await getUsage(request("/api/admin/usage", { admin: true }));
    expect(usageResponse.status).toBe(200);
    expect((await usageResponse.json()).totals.requests).toBe(0);

    const billingResponse = await getBilling(request("/api/admin/billing", { admin: true }));
    expect(billingResponse.status).toBe(200);
    expect((await billingResponse.json()).totals.totalMicros).toBe(0);
  });
});
