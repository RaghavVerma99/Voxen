import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { generateResponse, synthesizeSpeech, transcribeAudio } from "@/lib/ai";
import { config } from "@/lib/config";
import { addMessage, getConversation, getHistory } from "@/lib/conversation";
import { AppError } from "@/lib/errors";
import { toErrorResponse } from "@/lib/http";

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const audio = formData.get("audio");
    const sessionId = formData.get("session_id")?.toString().trim() || randomUUID();
    const durationRaw = formData.get("audio_duration")?.toString();
    const duration = durationRaw ? Number(durationRaw) : Number.NaN;

    if (!(audio instanceof File) || audio.size === 0) {
      throw new AppError("EMPTY_AUDIO", "No audio received");
    }
    if (audio.size > config.maxAudioBytes) {
      throw new AppError(
        "AUDIO_TOO_LARGE",
        `Audio exceeds ${Math.floor(config.maxAudioBytes / (1024 * 1024))}MB limit`,
        413,
      );
    }
    if (!Number.isNaN(duration) && duration > config.maxAudioSeconds) {
      throw new AppError(
        "AUDIO_TOO_LONG",
        `Audio exceeds ${config.maxAudioSeconds}s limit`,
        413,
      );
    }

    const transcript = await transcribeAudio(audio);
    if (!transcript.trim()) {
      throw new AppError("NOTHING_HEARD", "No speech detected in audio");
    }

    addMessage(sessionId, "user", transcript);
    const reply = await generateResponse(getConversation(sessionId));
    addMessage(sessionId, "assistant", reply);

    let audioB64: string | null = null;
    try {
      audioB64 = await synthesizeSpeech(reply);
    } catch {
      audioB64 = null;
    }

    return NextResponse.json({
      session_id: sessionId,
      transcript,
      reply,
      audio: audioB64,
      history: getHistory(sessionId),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}