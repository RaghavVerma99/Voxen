import { NextRequest, NextResponse } from "next/server";
import { reset } from "@/lib/conversation";
import { AppError } from "@/lib/errors";
import { toErrorResponse } from "@/lib/http";

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => null)) as {
      session_id?: string;
    } | null;
    const sessionId = body?.session_id?.trim();
    if (!sessionId) {
      throw new AppError("MISSING_SESSION", "session_id is required");
    }
    reset(sessionId);
    return NextResponse.json({ status: "ok", session_id: sessionId });
  } catch (err) {
    return toErrorResponse(err);
  }
}