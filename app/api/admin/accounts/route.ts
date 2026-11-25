import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";

import { readJson } from "@/lib/body";
import { config } from "@/lib/config";
import { AppError } from "@/lib/errors";
import { guardRequest, rateLimitHeaders } from "@/lib/guard";
import { jsonOk, toErrorResponse } from "@/lib/http";
import {
  createAccount,
  listAccounts,
  requireAdmin,
  updateAccount,
} from "@/lib/identity";

export const dynamic = "force-dynamic";

interface AccountBody {
  id?: unknown;
  name?: unknown;
  email?: unknown;
  plan?: unknown;
  role?: unknown;
  status?: unknown;
}

async function authorize(request: NextRequest) {
  const limits = await guardRequest(request, "admin-accounts");
  await requireAdmin(request);
  return limits;
}

export async function GET(request: NextRequest) {
  const requestId = randomUUID();
  try {
    const limits = await authorize(request);
    return jsonOk(
      { accounts: await listAccounts() },
      requestId,
      200,
      rateLimitHeaders(limits),
    );
  } catch (err) {
    return toErrorResponse(err, requestId);
  }
}

export async function POST(request: NextRequest) {
  const requestId = randomUUID();
  try {
    const limits = await authorize(request);
    const body = (await readJson<AccountBody>(request, config.maxChatRequestBytes)) ?? {};
    const created = await createAccount({
      name: typeof body.name === "string" ? body.name : "",
      email: typeof body.email === "string" ? body.email : undefined,
      plan: body.plan,
      role: body.role,
    });
    return jsonOk(created, requestId, 201, rateLimitHeaders(limits));
  } catch (err) {
    return toErrorResponse(err, requestId);
  }
}

export async function PATCH(request: NextRequest) {
  const requestId = randomUUID();
  try {
    const limits = await authorize(request);
    const body = (await readJson<AccountBody>(request, config.maxChatRequestBytes)) ?? {};
    if (typeof body.id !== "string" || !body.id.trim()) {
      throw new AppError("INVALID_BODY", "An account id is required.", 400);
    }
    const account = await updateAccount(body.id, {
      plan: body.plan,
      role: body.role,
      status: body.status,
    });
    return jsonOk({ account }, requestId, 200, rateLimitHeaders(limits));
  } catch (err) {
    return toErrorResponse(err, requestId);
  }
}
