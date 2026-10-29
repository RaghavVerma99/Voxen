import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { reset } from "@/lib/conversation";
import { guardRequest } from "@/lib/guard";
import { jsonOk, toErrorResponse } from "@/lib/http";
import { requireSessionId } from "@/lib/validate";

interface ResetBody {
  session_id?: unknown;
}

export async function POST(request: NextRequest) {
  const requestId = randomUUID();

  try {
    guardRequest(request, "reset");
    const body = (await request.json().catch(() => null)) as ResetBody | null;
    const sessionId = requireSessionId(body?.session_id);

    reset(sessionId);
    return jsonOk({ status: "ok", session_id: sessionId }, requestId);
  } catch (err) {
    return toErrorResponse(err, requestId);
  }
}
