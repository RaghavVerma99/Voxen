import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";

import { quotaSnapshot, usageSnapshot } from "@/lib/billing";
import { AppError } from "@/lib/errors";
import { guardRequest, rateLimitHeaders } from "@/lib/guard";
import { jsonOk, toErrorResponse } from "@/lib/http";
import { getAccount } from "@/lib/identity";

export const dynamic = "force-dynamic";

/** Current API account, daily quota, and metered usage. */
export async function GET(request: NextRequest) {
  const requestId = randomUUID();

  try {
    const limits = await guardRequest(request, "account");
    if (!limits.identity) {
      throw new AppError("AUTH_REQUIRED", "An API key is required.", 401);
    }
    const account = await getAccount(limits.identity.accountId);
    return jsonOk(
      {
        account,
        plan: limits.identity.plan,
        role: limits.identity.role,
        quota: await quotaSnapshot(limits.identity),
        usage: await usageSnapshot(limits.identity),
      },
      requestId,
      200,
      rateLimitHeaders(limits),
    );
  } catch (err) {
    return toErrorResponse(err, requestId);
  }
}
