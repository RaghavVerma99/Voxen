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
    const limits = guardRequest(request, "admin-usage");
    requireAdmin(request);
    return jsonOk(usageReport(), requestId, 200, rateLimitHeaders(limits));
  } catch (err) {
    return toErrorResponse(err, requestId);
  }
}
