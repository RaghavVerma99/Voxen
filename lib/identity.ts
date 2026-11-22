import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";

import { isPlanName, PLANS } from "./billing";
import { config, isIdentityMisconfigured } from "./config";
import { AppError } from "./errors";
import {
  stateBackend,
  type AccountPlan,
  type AccountRole,
  type AccountStatus,
  type StoredAccount,
} from "./state";

const KEY_PATTERN = /^vk_[A-Za-z0-9_-]{32,128}$/;
const DEV_SECRET = "voxen-local-development-secret";

export interface IdentityContext {
  accountId: string;
  plan: AccountPlan;
  role: AccountRole;
}

export type PublicAccount = Omit<StoredAccount, "keyHash">;

export interface NewAccountInput {
  name: string;
  email?: string;
  plan?: unknown;
  role?: unknown;
}

export interface AccountPatch {
  plan?: unknown;
  status?: unknown;
  role?: unknown;
}

function activeSecret(): string {
  if (config.identitySecret.trim()) return config.identitySecret;
  if (config.isProduction || config.identityRequired) {
    throw new AppError(
      "CONFIG_ERROR",
      `IDENTITY_SECRET must be set to at least ${config.minIdentitySecretLength} characters.`,
      503,
    );
  }
  return DEV_SECRET;
}

function hashApiKey(key: string): string {
  return createHmac("sha256", activeSecret()).update(key).digest("hex");
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function publicAccount(account: StoredAccount): PublicAccount {
  const { keyHash: _keyHash, ...rest } = account;
  return rest;
}

function cleanName(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim().replace(/\s+/g, " ").slice(0, 80);
}

function cleanEmail(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, 160);
}

function parsePlan(value: unknown, fallback: AccountPlan): AccountPlan {
  if (value === undefined) return fallback;
  if (!isPlanName(value)) {
    throw new AppError("INVALID_PLAN", "Unknown account plan.", 400);
  }
  return value;
}

function parseRole(value: unknown, fallback: AccountRole): AccountRole {
  if (value === undefined) return fallback;
  if (value !== "user" && value !== "admin") {
    throw new AppError("INVALID_ROLE", "Unknown account role.", 400);
  }
  return value;
}

function parseStatus(value: unknown, fallback: AccountStatus): AccountStatus {
  if (value === undefined) return fallback;
  if (value !== "active" && value !== "disabled") {
    throw new AppError("INVALID_STATUS", "Unknown account status.", 400);
  }
  return value;
}

/** Creates an account and returns its API key exactly once. */
export function createAccount(input: NewAccountInput): {
  account: PublicAccount;
  apiKey: string;
} {
  const name = cleanName(input.name);
  if (!name) {
    throw new AppError("INVALID_NAME", "Account name is required.", 400);
  }

  const apiKey = `vk_${randomBytes(32).toString("base64url")}`;
  const account: StoredAccount = {
    id: randomUUID(),
    name,
    email: cleanEmail(input.email),
    keyHash: hashApiKey(apiKey),
    plan: parsePlan(input.plan, "free"),
    role: parseRole(input.role, "user"),
    status: "active",
    createdAt: new Date().toISOString(),
  };

  stateBackend().write((document) => {
    document.accounts[account.id] = account;
  });
  return { account: publicAccount(account), apiKey };
}

export function listAccounts(): PublicAccount[] {
  return stateBackend().read((document) =>
    Object.values(document.accounts).map(publicAccount),
  );
}

export function updateAccount(id: string, patch: AccountPatch): PublicAccount {
  return stateBackend().write((document) => {
    const account = document.accounts[id];
    if (!account) {
      throw new AppError("ACCOUNT_NOT_FOUND", "Account not found.", 404);
    }
    const plan = parsePlan(patch.plan, account.plan);
    const role = parseRole(patch.role, account.role);
    const status = parseStatus(patch.status, account.status);
    document.accounts[id] = { ...account, plan, role, status };
    return publicAccount(document.accounts[id]);
  });
}

/** Resolves an API key from the Authorization or x-api-key header. */
export function identityFromRequest(request: NextRequest): IdentityContext | null {
  const bearer = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  const raw = bearer ?? request.headers.get("x-api-key") ?? "";
  if (!raw.trim()) {
    if (isIdentityMisconfigured()) {
      throw new AppError(
        "CONFIG_ERROR",
        `IDENTITY_SECRET must be set to at least ${config.minIdentitySecretLength} characters.`,
        503,
      );
    }
    if (config.identityRequired) {
      throw new AppError("AUTH_REQUIRED", "An API key is required.", 401);
    }
    return null;
  }

  const key = raw.trim();
  if (!KEY_PATTERN.test(key)) {
    throw new AppError("AUTH_INVALID", "Invalid API key format.", 401);
  }

  const keyHash = hashApiKey(key);
  return stateBackend().read((document) => {
    const account = Object.values(document.accounts).find(
      (candidate) =>
        candidate.status === "active" && safeEqual(candidate.keyHash, keyHash),
    );
    if (!account) {
      throw new AppError("AUTH_INVALID", "Invalid or disabled API key.", 401);
    }
    return {
      accountId: account.id,
      plan: account.plan,
      role: account.role,
    };
  });
}

/**
 * Admin access accepts the bootstrap ADMIN_API_KEY or an account with the
 * admin role. The bootstrap key is never stored and is checked in constant time.
 */
export function requireAdmin(request: NextRequest): IdentityContext {
  const adminKey = request.headers.get("x-admin-key") ?? "";
  if (config.adminApiKey && safeEqual(adminKey, config.adminApiKey)) {
    return {
      accountId: "bootstrap-admin",
      plan: "enterprise",
      role: "admin",
    };
  }
  const identity = identityFromRequest(request);
  if (!identity || identity.role !== "admin") {
    throw new AppError("ADMIN_REQUIRED", "Administrator access is required.", 403);
  }
  return identity;
}

export function planLimits(plan: AccountPlan): (typeof PLANS)[AccountPlan] {
  return PLANS[plan];
}
