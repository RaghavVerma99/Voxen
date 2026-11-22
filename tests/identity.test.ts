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

  beforeEach(() => {
    useStateBackendForTests(createMemoryStateBackend());
    config.identitySecret = "test-identity-secret-1234";
    config.identityRequired = false;
    config.adminApiKey = "test-admin-key-12345678";
  });

  afterEach(() => {
    Object.assign(config, original);
  });

  it("returns the API key only at creation and never stores it in plaintext", () => {
    const { account, apiKey } = createAccount({
      name: "  Ada   Lovelace ",
      email: "ada@example.com",
      plan: "pro",
    });

    expect(apiKey).toMatch(/^vk_[A-Za-z0-9_-]{32,}$/);
    expect(account.name).toBe("Ada Lovelace");
    expect("keyHash" in account).toBe(false);
    expect(listAccounts()).toEqual([account]);

    const stored = stateBackend().read((document) =>
      JSON.stringify(document.accounts),
    );
    expect(stored).not.toContain(apiKey);
    expect(stored).toContain("keyHash");
  });

  it("resolves a valid key and rejects invalid or disabled ones", () => {
    const { apiKey } = createAccount({ name: "Grace", plan: "enterprise" });

    expect(
      identityFromRequest(request({ authorization: `Bearer ${apiKey}` })),
    ).toMatchObject({ plan: "enterprise", role: "user" });
    expect(identityFromRequest(request({ "x-api-key": apiKey }))?.accountId).toBeTruthy();

    expect(() =>
      identityFromRequest(request({ "x-api-key": "vk_short" })),
    ).toThrowError(expect.objectContaining({ code: "AUTH_INVALID" }));

    const account = listAccounts()[0];
    updateAccount(account.id, { status: "disabled" });
    expect(() => identityFromRequest(request({ "x-api-key": apiKey }))).toThrowError(
      expect.objectContaining({ code: "AUTH_INVALID" }),
    );
  });

  it("requires a key when identity mode is enabled", () => {
    config.identityRequired = true;
    expect(() => identityFromRequest(request())).toThrowError(
      expect.objectContaining({ code: "AUTH_REQUIRED" }),
    );
  });

  it("accepts the bootstrap admin key even when identity mode is enabled", () => {
    config.identityRequired = true;
    config.identitySecret = "";
    const headers = { "x-admin-key": config.adminApiKey };

    expect(identityFromRequest(request(headers))).toMatchObject({
      accountId: "bootstrap-admin",
      role: "admin",
    });
    expect(requireAdmin(request(headers))).toMatchObject({
      accountId: "bootstrap-admin",
      role: "admin",
    });
  });

  it("fails closed when identity mode lacks a signing secret", () => {
    config.identityRequired = true;
    config.identitySecret = "";
    expect(() => identityFromRequest(request())).toThrowError(
      expect.objectContaining({ code: "CONFIG_ERROR" }),
    );
  });

  it("accepts the bootstrap admin key or an admin-role account", () => {
    expect(
      requireAdmin(request({ "x-admin-key": config.adminApiKey })),
    ).toMatchObject({ accountId: "bootstrap-admin", role: "admin" });

    const { apiKey } = createAccount({ name: "Admin", role: "admin" });
    expect(
      requireAdmin(request({ "x-api-key": apiKey })),
    ).toMatchObject({ role: "admin" });

    expect(() => requireAdmin(request())).toThrowError(
      expect.objectContaining({ code: "ADMIN_REQUIRED" }),
    );
  });

  it("validates plan, role, and status changes", () => {
    const { account } = createAccount({ name: "User" });
    expect(() => updateAccount(account.id, { plan: "platinum" })).toThrowError(
      expect.objectContaining({ code: "INVALID_PLAN" }),
    );
    expect(updateAccount(account.id, { plan: "pro", role: "admin" })).toMatchObject({
      plan: "pro",
      role: "admin",
    });
  });
});
