import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { generateResponse } from "@/lib/ai";
import { addMessage, getConversation, getHistory } from "@/lib/conversation";
import { AppError } from "@/lib/errors";
import { toErrorResponse } from "@/lib/http";

interface ChatBody {
  session_id?: string;
  message?: string;
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => null)) as ChatBody | null;
    const message = body?.message?.trim() ?? "";
    if (!message) {
      throw new AppError("EMPTY_MESSAGE", "Message is empty");
    }
    const sessionId = body?.session_id?.trim() || randomUUID();

    addMessage(sessionId, "user", message);
    const reply = await generateResponse(getConversation(sessionId));
    addMessage(sessionId, "assistant", reply);

    return NextResponse.json({
      session_id: sessionId,
      reply,
      history: getHistory(sessionId),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}