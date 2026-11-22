import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";

import { billingReport } from "@/lib/billing";
import { guardRequest, rateLimitHeaders } from "@/lib/guard";
import { jsonOk, toErrorResponse } from "@/lib/http";
import { requireAdmin } from "@/lib/identity";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const requestId = randomUUID();
  try {
    const limits = guardRequest(request, "admin-billing");
    requireAdmin(request);
    const lines = billingReport();
    return jsonOk(
      {
        lines,
        totals: lines.reduce(
          (total, line) => ({
            baseMicros: total.baseMicros + line.baseMicros,
            requestMicros: total.requestMicros + line.requestMicros,
            usageMicros: total.usageMicros + line.usageMicros,
            totalMicros: total.totalMicros + line.totalMicros,
          }),
          {
            baseMicros: 0,
            requestMicros: 0,
            usageMicros: 0,
            totalMicros: 0,
          },
        ),
      },
      requestId,
      200,
      rateLimitHeaders(limits),
    );
  } catch (err) {
    return toErrorResponse(err, requestId);
  }
}
