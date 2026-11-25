import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { getHistory } from "@/lib/conversation";
import { guardRequest, rateLimitHeaders } from "@/lib/guard";
import { jsonOk, toErrorResponse } from "@/lib/http";
import { requireSessionId } from "@/lib/validate";

export async function GET(request: NextRequest) {
  const requestId = randomUUID();

  try {
    const limits = await guardRequest(request, "history");
    const sessionId = requireSessionId(
      request.headers.get("x-session-id") ??
        request.nextUrl.searchParams.get("session_id"),
    );

    return jsonOk(
      { session_id: sessionId, history: await getHistory(sessionId) },
      requestId,
      200,
      rateLimitHeaders(limits),
    );
  } catch (err) {
    return toErrorResponse(err, requestId);
  }
}
