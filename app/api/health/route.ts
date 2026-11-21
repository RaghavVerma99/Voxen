import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { config, isAiConfigured, ttsProviderChain } from "@/lib/config";
import { sessionStats } from "@/lib/conversation";
import { guardRequest, rateLimitHeaders } from "@/lib/guard";
import { jsonOk, toErrorResponse } from "@/lib/http";
import { budgetSnapshot } from "@/lib/ratelimit";
import { activeSearchProvider } from "@/lib/tools";

export async function GET(request: NextRequest) {
  const requestId = randomUUID();
  const accessRequired = config.accessCode.length > 0;

  try {
    const wantsDetail = request.nextUrl.searchParams.get("detail") === "1";
    const wantsVerify = request.nextUrl.searchParams.get("verify") === "1";
    const guarded = wantsDetail || wantsVerify;
    const limits = guarded ? guardRequest(request, "health") : undefined;

    const payload: Record<string, unknown> = {
      status: "ok",
      name: config.appName,
      version: config.appVersion,
      uptime_seconds: Math.round(process.uptime()),
      access_required: accessRequired,
    };

    // Configuration, budget and session counts are intentionally private.
    if (wantsDetail) {
      const stats = sessionStats();
      payload.checks = {
        ai: isAiConfigured() ? "configured" : "missing",
        search: activeSearchProvider(),
        tts: ttsProviderChain(),
      };
      payload.budget = budgetSnapshot();
      payload.sessions = stats.sessions;
    }

    return jsonOk(
      payload,
      requestId,
      200,
      limits ? rateLimitHeaders(limits) : undefined,
    );
  } catch (err) {
    return toErrorResponse(err, requestId);
  }
}
