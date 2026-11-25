import { NextRequest } from "next/server";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { config } from "@/lib/config";
import {
  createAccount,
  identityFromRequest,
  listAccounts,
  requireAdmin,
  updateAccount,
} from "@/lib/identity";
import {
  createMemoryStateBackend,
  stateBackend,
  useStateBackendForTests,
} from "@/lib/state";

function request(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://localhost/api/test", { headers });
}

describe("account identities", () => {
  const original = {
    secret: config.identitySecret,
    required: config.identityRequired,
    adminKey: config.adminApiKey,
  };

  beforeEach(async () => {
    useStateBackendForTests(createMemoryStateBackend());
    config.identitySecret = "test-identity-secret-1234";
    config.identityRequired = false;
    config.adminApiKey = "test-admin-key-12345678";
  });

  afterEach(async () => {
    Object.assign(config, original);
  });

  it("returns the API key only at creation and never stores it in plaintext", async () => {
    const { account, apiKey } = await createAccount({
      name: "  Ada   Lovelace ",
      email: "ada@example.com",
      plan: "pro",
    });

    expect(apiKey).toMatch(/^vk_[A-Za-z0-9_-]{32,}$/);
    expect(account.name).toBe("Ada Lovelace");
    expect("keyHash" in account).toBe(false);
    expect(await listAccounts()).toEqual([account]);

    const stored = await stateBackend().read((document) =>
      JSON.stringify(document.accounts),
    );
    expect(stored).not.toContain(apiKey);
    expect(stored).toContain("keyHash");
  });

  it("resolves a valid key and rejects invalid or disabled ones", async () => {
    const { apiKey } = await createAccount({ name: "Grace", plan: "enterprise" });

    expect(
      await identityFromRequest(request({ authorization: `Bearer ${apiKey}` })),
    ).toMatchObject({ plan: "enterprise", role: "user" });
    expect((await identityFromRequest(request({ "x-api-key": apiKey })))?.accountId).toBeTruthy();

    await expect(identityFromRequest(request({ "x-api-key": "vk_short" }))).rejects.toThrowError(expect.objectContaining({ code: "AUTH_INVALID" }));

    const account = (await listAccounts())[0];
    await updateAccount(account.id, { status: "disabled" });
    await expect(identityFromRequest(request({ "x-api-key": apiKey }))).rejects.toThrowError(
      expect.objectContaining({ code: "AUTH_INVALID" }),
    );
  });

  it("requires a key when identity mode is enabled", async () => {
    config.identityRequired = true;
    await expect(identityFromRequest(request())).rejects.toThrowError(
      expect.objectContaining({ code: "AUTH_REQUIRED" }),
    );
  });

  it("accepts the bootstrap admin key even when identity mode is enabled", async () => {
    config.identityRequired = true;
    config.identitySecret = "";
    const headers = { "x-admin-key": config.adminApiKey };

    expect(await identityFromRequest(request(headers))).toMatchObject({
      accountId: "bootstrap-admin",
      role: "admin",
    });
    expect(await requireAdmin(request(headers))).toMatchObject({
      accountId: "bootstrap-admin",
      role: "admin",
    });
  });

  it("fails closed when identity mode lacks a signing secret", async () => {
    config.identityRequired = true;
    config.identitySecret = "";
    await expect(identityFromRequest(request())).rejects.toThrowError(
      expect.objectContaining({ code: "CONFIG_ERROR" }),
    );
  });

  it("accepts the bootstrap admin key or an admin-role account", async () => {
    expect(
      await requireAdmin(request({ "x-admin-key": config.adminApiKey })),
    ).toMatchObject({ accountId: "bootstrap-admin", role: "admin" });

    const { apiKey } = await createAccount({ name: "Admin", role: "admin" });
    expect(
      await requireAdmin(request({ "x-api-key": apiKey })),
    ).toMatchObject({ role: "admin" });

    await expect(requireAdmin(request())).rejects.toThrowError(
      expect.objectContaining({ code: "ADMIN_REQUIRED" }),
    );
  });

  it("validates plan, role, and status changes", async () => {
    const { account } = await createAccount({ name: "User" });
    await expect(updateAccount(account.id, { plan: "platinum" })).rejects.toThrowError(
      expect.objectContaining({ code: "INVALID_PLAN" }),
    );
    expect(await updateAccount(account.id, { plan: "pro", role: "admin" })).toMatchObject({
      plan: "pro",
      role: "admin",
    });
  });
});
