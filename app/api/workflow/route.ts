import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { config } from "@/lib/config";
import { guardRequest, rateLimitHeaders } from "@/lib/guard";
import { jsonOk, toErrorResponse } from "@/lib/http";
import { resolveSessionId } from "@/lib/validate";
import {
  getWorkflow,
  listAppointments,
  workflowStats,
} from "@/lib/workflow-store";

export const dynamic = "force-dynamic";

/** Returns the persisted workflow state for a session, never another user's. */
export async function GET(request: NextRequest) {
  const requestId = randomUUID();

  try {
    const limits = guardRequest(request, "workflow");
    const sessionId = resolveSessionId(
      request.headers.get("x-session-id") ??
        request.nextUrl.searchParams.get("session_id"),
    );
    const [workflow, appointments, stats] = await Promise.all([
      getWorkflow(sessionId),
      listAppointments(sessionId),
      workflowStats(),
    ]);

    return jsonOk(
      {
        session_id: sessionId,
        enabled: config.workflowEnabled,
        workflow,
        appointments,
        stats,
      },
      requestId,
      200,
      rateLimitHeaders(limits),
    );
  } catch (err) {
    return toErrorResponse(err, requestId);
  }
}
