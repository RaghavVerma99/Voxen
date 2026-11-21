import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { AppError } from "@/lib/errors";
import { jsonOk, toErrorResponse } from "@/lib/http";
import { getShare } from "@/lib/workflow-store";

export const dynamic = "force-dynamic";

/**
 * Shareable, read-only transcript. Access is controlled by the high-entropy
 * token itself; the session id is intentionally omitted from the payload.
 */
export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ token: string }> },
) {
  const requestId = randomUUID();

  try {
    const { token } = await context.params;
    const share = await getShare(token);
    if (!share) {
      throw new AppError("NOT_FOUND", "This transcript is not available", 404);
    }

    return jsonOk(
      {
        summary: share.summary,
        transcript: share.transcript,
        created_at: share.createdAt,
      },
      requestId,
    );
  } catch (err) {
    return toErrorResponse(err, requestId);
  }
}
