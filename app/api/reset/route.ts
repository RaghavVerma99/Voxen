import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { readJson } from "@/lib/body";
import { config } from "@/lib/config";
import { reset } from "@/lib/conversation";
import { guardRequest, rateLimitHeaders } from "@/lib/guard";
import { jsonOk, toErrorResponse } from "@/lib/http";
import { requireSessionId } from "@/lib/validate";

interface ResetBody {
  session_id?: unknown;
}

export async function POST(request: NextRequest) {
  const requestId = randomUUID();

  try {
    const limits = await guardRequest(request, "reset");
    const body = await readJson<ResetBody>(request, config.maxChatRequestBytes);
    const sessionId = requireSessionId(body?.session_id);

    reset(sessionId);
    return jsonOk(
      { status: "ok", session_id: sessionId },
      requestId,
      200,
      rateLimitHeaders(limits),
    );
  } catch (err) {
    return toErrorResponse(err, requestId);
  }
}
