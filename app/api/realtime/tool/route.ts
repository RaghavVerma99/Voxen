import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { readJson } from "@/lib/body";
import { config } from "@/lib/config";
import { AppError } from "@/lib/errors";
import { guardRequest, rateLimitHeaders } from "@/lib/guard";
import { jsonOk, toErrorResponse } from "@/lib/http";
import { activeToolSchemas, runTool } from "@/lib/tools";
import { requireSessionId } from "@/lib/validate";

interface ToolBody {
  session_id?: unknown;
  call_id?: unknown;
  name?: unknown;
  arguments?: unknown;
}

export const dynamic = "force-dynamic";

/**
 * Executes a Realtime function call with the server-owned session id. The
 * browser may choose a tool, but it cannot choose whose workflow is mutated.
 */
export async function POST(request: NextRequest) {
  const requestId = randomUUID();

  try {
    const limits = await guardRequest(request, "realtime-tool");
    if (!config.realtimeEnabled) {
      throw new AppError(
        "CONFIG_ERROR",
        "The Realtime transport is disabled.",
        503,
      );
    }

    const body = (await readJson<ToolBody>(request, config.maxChatRequestBytes)) ?? {};
    const sessionId = requireSessionId(body.session_id);
    const callId =
      typeof body.call_id === "string" && body.call_id.trim()
        ? body.call_id.trim().slice(0, 128)
        : "";
    const name =
      typeof body.name === "string" && body.name.trim()
        ? body.name.trim()
        : "";
    if (!callId || !name) {
      throw new AppError(
        "INVALID_BODY",
        "A call id and tool name are required.",
        400,
      );
    }

    const allowed = new Set(activeToolSchemas().map((tool) => tool.function.name));
    if (!allowed.has(name)) {
      throw new AppError("INVALID_BODY", `Unknown tool: ${name}`, 400);
    }

    let argumentsJson: string;
    if (typeof body.arguments === "string") {
      argumentsJson = body.arguments;
    } else if (body.arguments && typeof body.arguments === "object") {
      argumentsJson = JSON.stringify(body.arguments);
    } else {
      argumentsJson = "{}";
    }
    if (argumentsJson.length > config.maxMessageChars * 4) {
      throw new AppError("PAYLOAD_TOO_LARGE", "Tool arguments are too large.", 413);
    }

    const output = await runTool(name, argumentsJson, {
      sessionId,
      source: "realtime",
    });
    return jsonOk(
      { session_id: sessionId, call_id: callId, name, output },
      requestId,
      200,
      rateLimitHeaders(limits),
    );
  } catch (err) {
    return toErrorResponse(err, requestId);
  }
}
