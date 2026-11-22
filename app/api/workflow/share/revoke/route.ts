import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { readJson } from "@/lib/body";
import { config } from "@/lib/config";
import { AppError } from "@/lib/errors";
import { guardRequest, rateLimitHeaders } from "@/lib/guard";
import { jsonOk, toErrorResponse } from "@/lib/http";
import { requireSessionId } from "@/lib/validate";
import { revokeShare } from "@/lib/workflow-store";

interface RevokeBody {
  session_id?: unknown;
  share_token?: unknown;
}

export const dynamic = "force-dynamic";

/**
 * Revokes a share link for its owning session. A token that is unknown or
 * belongs to another session produces the same `revoked: false` response, so
 * this route cannot be used to enumerate active links.
 */
export async function POST(request: NextRequest) {
  const requestId = randomUUID();

  try {
    const limits = guardRequest(request, "workflow-share-revoke");
    const body = await readJson<RevokeBody>(request, config.maxChatRequestBytes);
    const sessionId = requireSessionId(body?.session_id);
    const token =
      typeof body?.share_token === "string"
        ? body.share_token.trim().slice(0, 128)
        : "";
    if (!token) {
      throw new AppError("INVALID_BODY", "share_token is required.", 400);
    }

    const revoked = await revokeShare(token, sessionId);
    return jsonOk(
      { revoked },
      requestId,
      200,
      rateLimitHeaders(limits),
    );
  } catch (err) {
    return toErrorResponse(err, requestId);
  }
}
