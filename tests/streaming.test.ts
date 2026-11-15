import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const provider = vi.hoisted(() => ({
  ensureAiConfigured: vi.fn(),
  transcribeAudio: vi.fn(),
  streamResponse: vi.fn(),
  synthesizeSpeech: vi.fn(),
}));

vi.mock("@/lib/ai", () => provider);

import { POST as postChatStream } from "@/app/api/chat/stream/route";
import { POST as postVoiceStream } from "@/app/api/voice/stream/route";
import { config } from "@/lib/config";
import { getHistory } from "@/lib/conversation";
import { AppError } from "@/lib/errors";
import { budgetSnapshot } from "@/lib/ratelimit";
import type { StreamHandlers } from "@/lib/ai";

const mockTranscribe = vi.mocked(provider.transcribeAudio);
const mockStream = vi.mocked(provider.streamResponse);
const mockSynthesize = vi.mocked(provider.synthesizeSpeech);

let sessionCounter = 0;
function nextSession(): string {
  sessionCounter += 1;
  return `stream-session-${sessionCounter}`;
}

function chatStreamRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/chat/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function voiceStreamRequest(
  sessionId: string,
  speak: boolean,
  bytes = 64,
): NextRequest {
  const form = new FormData();
  form.append(
    "audio",
    new File([new Uint8Array(bytes)], "rec.webm", { type: "audio/webm" }),
  );
  form.append("session_id", sessionId);
  form.append("audio_duration", "1.5");
  form.append("speak", String(speak));
  return new NextRequest("http://localhost/api/voice/stream", {
    method: "POST",
    body: form,
  });
}

interface SseEvent {
  event: string;
  data: Record<string, unknown>;
}

function parseEvents(raw: string): SseEvent[] {
  return raw
    .split("\n\n")
    .map((frame) => frame.trim())
    .filter(Boolean)
    .map((frame) => {
      let event = "message";
      const data: string[] = [];
      for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).trim());
      }
      return { event, data: JSON.parse(data.join("\n")) };
    });
}

function deltaStream(...chunks: string[]) {
  return async (_messages: unknown, handlers: StreamHandlers) => {
    for (const chunk of chunks) handlers.onDelta(chunk);
    return chunks.join("");
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  config.accessCode = "";
  config.rateLimitRequests = 1_000;
  config.dailyRequestBudget = 100_000;
  provider.ensureAiConfigured.mockReturnValue(undefined);
  mockSynthesize.mockResolvedValue("QUJD");
});

describe("chat stream", () => {
  it("streams text, audio and a final history snapshot", async () => {
    const sessionId = nextSession();
    mockStream.mockImplementation(deltaStream("Hello ", "world."));

    const response = await postChatStream(
      chatStreamRequest({
        session_id: sessionId,
        message: "hi",
        speak: true,
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const events = parseEvents(await response.text());
    expect(events.map((event) => event.event)).toEqual([
      "session",
      "delta",
      "delta",
      "audio",
      "done",
    ]);
    expect(events[0].data).toEqual({ session_id: sessionId });
    expect(events[1].data).toEqual({ text: "Hello " });
    expect(events[3].data).toMatchObject({ index: 0, audio: "QUJD" });
    expect(events[4].data).toMatchObject({
      session_id: sessionId,
      reply: "Hello world.",
      spoken: true,
    });
    expect(events[4].data.history).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "Hello world." },
    ]);
    expect(getHistory(sessionId)).toHaveLength(2);
  });

  it("suppresses speech when speak is false", async () => {
    mockStream.mockImplementation(deltaStream("Text only."));

    const response = await postChatStream(
      chatStreamRequest({
        session_id: nextSession(),
        message: "hi",
        speak: false,
      }),
    );

    const events = parseEvents(await response.text());
    expect(events.some((event) => event.event === "audio")).toBe(false);
    expect(mockSynthesize).not.toHaveBeenCalled();
    expect(events.at(-1)?.data).toMatchObject({ spoken: false });
  });

  it("emits an error event and keeps history clean when the model fails", async () => {
    const sessionId = nextSession();
    const before = budgetSnapshot().used;
    mockStream.mockRejectedValue(
      new AppError("LLM_FAILED", "upstream down", 502),
    );

    const response = await postChatStream(
      chatStreamRequest({ session_id: sessionId, message: "hi" }),
    );

    expect(response.status).toBe(200);
    const events = parseEvents(await response.text());
    expect(events.map((event) => event.event)).toEqual(["session", "error"]);
    expect(events[1].data).toMatchObject({
      error_code: "LLM_FAILED",
      message: "upstream down",
    });
    expect(getHistory(sessionId)).toEqual([]);
    expect(budgetSnapshot().used).toBe(before);
  });

  it("rejects invalid requests before starting the stream", async () => {
    const response = await postChatStream(
      chatStreamRequest({ session_id: nextSession(), message: "  " }),
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = (await response.json()) as { detail: { error_code: string } };
    expect(body.detail.error_code).toBe("EMPTY_MESSAGE");
    expect(mockStream).not.toHaveBeenCalled();
  });
});

describe("voice stream", () => {
  it("streams the transcript, reply and audio", async () => {
    const sessionId = nextSession();
    mockTranscribe.mockResolvedValue("what time is it");
    mockStream.mockImplementation(deltaStream("It is noon."));

    const response = await postVoiceStream(
      voiceStreamRequest(sessionId, true),
    );

    expect(response.status).toBe(200);
    const events = parseEvents(await response.text());
    expect(events.map((event) => event.event)).toEqual([
      "session",
      "transcript",
      "delta",
      "audio",
      "done",
    ]);
    expect(events[1].data).toEqual({ transcript: "what time is it" });
    expect(events.at(-1)?.data).toMatchObject({
      reply: "It is noon.",
      spoken: true,
    });
  });

  it("returns a JSON error when transcription finds no speech", async () => {
    const before = budgetSnapshot().used;
    mockTranscribe.mockResolvedValue("   ");

    const response = await postVoiceStream(
      voiceStreamRequest(nextSession(), true),
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { detail: { error_code: string } };
    expect(body.detail.error_code).toBe("NOTHING_HEARD");
    expect(mockStream).not.toHaveBeenCalled();
    expect(budgetSnapshot().used).toBe(before);
  });

  it("requires audio_duration before reserving budget or calling STT", async () => {
    const before = budgetSnapshot().used;
    const form = new FormData();
    form.append(
      "audio",
      new File([new Uint8Array(64)], "rec.webm", { type: "audio/webm" }),
    );
    form.append("session_id", nextSession());

    const response = await postVoiceStream(
      new NextRequest("http://localhost/api/voice/stream", {
        method: "POST",
        body: form,
      }),
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { detail: { error_code: string } };
    expect(body.detail.error_code).toBe("INVALID_AUDIO_DURATION");
    expect(mockTranscribe).not.toHaveBeenCalled();
    expect(budgetSnapshot().used).toBe(before);
  });
});
