import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { generateResponse, synthesizeSpeech, transcribeAudio } from "@/lib/ai";
import { AppError } from "@/lib/errors";
import { getHistory } from "@/lib/conversation";

vi.mock("@/lib/ai", () => ({
  transcribeAudio: vi.fn(),
  generateResponse: vi.fn(),
  synthesizeSpeech: vi.fn(),
}));

import { GET as getHealth } from "@/app/api/health/route";
import { POST as postChat } from "@/app/api/chat/route";
import { POST as postReset } from "@/app/api/reset/route";
import { POST as postVoice } from "@/app/api/voice/route";

const mockTranscribe = vi.mocked(transcribeAudio);
const mockGenerate = vi.mocked(generateResponse);
const mockSynthesize = vi.mocked(synthesizeSpeech);

function chatRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function resetRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/reset", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function voiceRequest(formData: FormData): NextRequest {
  return new NextRequest("http://localhost/api/voice", {
    method: "POST",
    body: formData,
  });
}

function audioForm(options?: {
  sessionId?: string;
  bytes?: number;
  duration?: string;
}): FormData {
  const size = options?.bytes ?? 64;
  const form = new FormData();
  form.append(
    "audio",
    new File([new Uint8Array(size)], "rec.webm", { type: "audio/webm" }),
  );
  form.append("session_id", options?.sessionId ?? "s1");
  if (options?.duration !== undefined) {
    form.append("audio_duration", options.duration);
  }
  return form;
}

async function bodyOf(response: Response): Promise<Record<string, unknown>> {
  const json = (await response.json()) as Record<string, unknown>;
  return json;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("health", () => {
  it("reports ok", async () => {
    const response = await getHealth();
    expect(await bodyOf(response)).toEqual({ status: "ok" });
  });
});

describe("chat", () => {
  it("returns a reply and persists history across turns", async () => {
    mockGenerate.mockImplementation(async (messages) => {
      const count = messages.filter((m) => m.role === "user").length;
      return count === 1 ? "first reply" : "second reply";
    });

    const first = await postChat(chatRequest({ session_id: "s1", message: "hi" }));
    expect(first.status).toBe(200);
    expect((await bodyOf(first)).reply).toBe("first reply");

    const second = await postChat(chatRequest({ session_id: "s1", message: "again" }));
    const secondBody = await bodyOf(second);
    expect(second.status).toBe(200);
    expect(secondBody.reply).toBe("second reply");
    const history = secondBody.history as { content: string }[];
    expect(history.map((m) => m.content)).toEqual([
      "hi",
      "first reply",
      "again",
      "second reply",
    ]);
  });

  it("rejects blank messages", async () => {
    const response = await postChat(chatRequest({ session_id: "s1", message: "   " }));
    expect(response.status).toBe(400);
    const detail = (await bodyOf(response)).detail as { error_code: string };
    expect(detail.error_code).toBe("EMPTY_MESSAGE");
    expect(mockGenerate).not.toHaveBeenCalled();
  });
});

describe("reset", () => {
  it("clears only the target session", async () => {
    mockGenerate.mockResolvedValue("ok");
    await postChat(chatRequest({ session_id: "s1", message: "hi" }));
    await postChat(chatRequest({ session_id: "s2", message: "bye" }));

    const response = await postReset(resetRequest({ session_id: "s1" }));
    expect(response.status).toBe(200);
    expect(getHistory("s1")).toEqual([]);
    expect(getHistory("s2")).toHaveLength(2);
  });

  it("requires a session id", async () => {
    const response = await postReset(resetRequest({}));
    expect(response.status).toBe(400);
    const detail = (await bodyOf(response)).detail as { error_code: string };
    expect(detail.error_code).toBe("MISSING_SESSION");
  });
});

describe("voice", () => {
  it("returns transcript, reply, audio and history", async () => {
    mockTranscribe.mockResolvedValue("what is linux");
    mockGenerate.mockResolvedValue("a process is a running program");
    mockSynthesize.mockResolvedValue("TUVN");

    const response = await postVoice(voiceRequest(audioForm()));
    expect(response.status).toBe(200);
    const body = await bodyOf(response);
    expect(body.transcript).toBe("what is linux");
    expect(body.reply).toBe("a process is a running program");
    expect(body.audio).toBe("TUVN");
    expect(body.history).toHaveLength(2);
  });

  it("degrades to text when TTS fails", async () => {
    mockTranscribe.mockResolvedValue("hello");
    mockGenerate.mockResolvedValue("hi there");
    mockSynthesize.mockRejectedValue(new Error("provider down"));

    const response = await postVoice(voiceRequest(audioForm()));
    expect(response.status).toBe(200);
    const body = await bodyOf(response);
    expect(body.reply).toBe("hi there");
    expect(body.audio).toBeNull();
  });

  it("rejects empty audio", async () => {
    const response = await postVoice(voiceRequest(audioForm({ bytes: 0 })));
    expect(response.status).toBe(400);
    const detail = (await bodyOf(response)).detail as { error_code: string };
    expect(detail.error_code).toBe("EMPTY_AUDIO");
  });

  it("rejects oversized audio", async () => {
    const response = await postVoice(voiceRequest(audioForm({ bytes: 11 * 1024 * 1024 })));
    expect(response.status).toBe(413);
    const detail = (await bodyOf(response)).detail as { error_code: string };
    expect(detail.error_code).toBe("AUDIO_TOO_LARGE");
  });

  it("rejects overly long audio", async () => {
    const response = await postVoice(
      voiceRequest(audioForm({ duration: "999" })),
    );
    expect(response.status).toBe(413);
    const detail = (await bodyOf(response)).detail as { error_code: string };
    expect(detail.error_code).toBe("AUDIO_TOO_LONG");
  });

  it("rejects audio with no detected speech", async () => {
    mockTranscribe.mockResolvedValue("   ");
    const response = await postVoice(voiceRequest(audioForm()));
    expect(response.status).toBe(400);
    const detail = (await bodyOf(response)).detail as { error_code: string };
    expect(detail.error_code).toBe("NOTHING_HEARD");
  });

  it("maps STT failures to 502", async () => {
    mockTranscribe.mockRejectedValue(new AppError("STT_FAILED", "bad key", 502));
    const response = await postVoice(voiceRequest(audioForm()));
    expect(response.status).toBe(502);
    const detail = (await bodyOf(response)).detail as { error_code: string };
    expect(detail.error_code).toBe("STT_FAILED");
  });
});