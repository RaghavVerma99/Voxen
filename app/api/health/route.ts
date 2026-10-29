import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { config, isAiConfigured } from "@/lib/config";
import { sessionStats } from "@/lib/conversation";
import { guardRequest } from "@/lib/guard";
import { jsonOk, toErrorResponse } from "@/lib/http";
import { budgetSnapshot } from "@/lib/ratelimit";
import { activeSearchProvider } from "@/lib/tools";

export async function GET(request: NextRequest) {
  const requestId = randomUUID();
  const accessRequired = config.accessCode.length > 0;

  try {
    // /api/health?verify=1 lets the client validate a stored access code.
    // Guard it too, so the code cannot be brute-forced without a rate limit.
    if (request.nextUrl.searchParams.get("verify") === "1") {
      guardRequest(request, "health");
    }

    const stats = sessionStats();

    return jsonOk(
      {
        status: "ok",
        name: config.appName,
        version: config.appVersion,
        uptime_seconds: Math.round(process.uptime()),
        access_required: accessRequired,
        checks: {
          ai: isAiConfigured() ? "configured" : "missing",
          search: activeSearchProvider(),
        },
        budget: budgetSnapshot(),
        sessions: stats.sessions,
      },
      requestId,
    );
  } catch (err) {
    return toErrorResponse(err, requestId);
  }
}
