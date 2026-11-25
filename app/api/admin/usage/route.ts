import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";

import { usageReport } from "@/lib/billing";
import { guardRequest, rateLimitHeaders } from "@/lib/guard";
import { jsonOk, toErrorResponse } from "@/lib/http";
import { requireAdmin } from "@/lib/identity";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const requestId = randomUUID();
  try {
    const limits = await guardRequest(request, "admin-usage");
    await requireAdmin(request);
    return jsonOk(await usageReport(), requestId, 200, rateLimitHeaders(limits));
  } catch (err) {
    return toErrorResponse(err, requestId);
  }
}
