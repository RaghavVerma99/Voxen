import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { readJson } from "@/lib/body";
import { config } from "@/lib/config";
import { getHistory } from "@/lib/conversation";
import { guardRequest, rateLimitHeaders } from "@/lib/guard";
import { jsonOk, toErrorResponse } from "@/lib/http";
import { resolveSessionId } from "@/lib/validate";
import {
  createShare,
  getWorkflow,
  listAppointments,
} from "@/lib/workflow-store";
import { buildPostCallSummary } from "@/lib/workflow-summary";

interface SummaryBody {
  session_id?: unknown;
}

export const dynamic = "force-dynamic";

/**
 * Creates a deterministic post-call summary and a random-token share link.
 * The share token is a bearer secret, so it never includes the session id.
 */
export async function POST(request: NextRequest) {
  const requestId = randomUUID();

  try {
    const limits = await guardRequest(request, "workflow-summary");
    const body = await readJson<SummaryBody>(request, config.maxChatRequestBytes);
    const sessionId = resolveSessionId(body?.session_id);

    const [workflow, appointments] = await Promise.all([
      getWorkflow(sessionId),
      listAppointments(sessionId),
    ]);
    const summary = buildPostCallSummary(
      await getHistory(sessionId),
      workflow,
      appointments,
    );
    const share = await createShare({
      sessionId,
      summary: summary.headline,
      transcript: summary.transcript,
    });

    return jsonOk(
      {
        session_id: sessionId,
        summary: {
          headline: summary.headline,
          action_items: summary.actionItems,
          decisions: summary.decisions,
        },
        share_token: share.token,
        share_url: `/api/transcript/${share.token}`,
        share_expires_at: share.expiresAt,
      },
      requestId,
      200,
      rateLimitHeaders(limits),
    );
  } catch (err) {
    return toErrorResponse(err, requestId);
  }
}
