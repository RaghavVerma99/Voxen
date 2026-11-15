import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { generateResponse, synthesizeSpeech, transcribeAudio } from "@/lib/ai";
import { config } from "@/lib/config";
import { getHistory } from "@/lib/conversation";
import { AppError } from "@/lib/errors";

vi.mock("@/lib/ai", () => ({
  ensureAiConfigured: vi.fn(),
  transcribeAudio: vi.fn(),
  generateResponse: vi.fn(),
  synthesizeSpeech: vi.fn(),
}));

import { POST as postChat } from "@/app/api/chat/route";
import { GET as getHistoryRoute } from "@/app/api/history/route";
import { GET as getHealth } from "@/app/api/health/route";
import { GET as getReady } from "@/app/api/ready/route";
import { POST as postReset } from "@/app/api/reset/route";
import { POST as postVoice } from "@/app/api/voice/route";

const mockTranscribe = vi.mocked(transcribeAudio);
const mockGenerate = vi.mocked(generateResponse);
const mockSynthesize = vi.mocked(synthesizeSpeech);

let sessionCounter = 0;

function nextSession(): string {
  sessionCounter += 1;
  return `test-session-${sessionCounter}`;
}

function requestHeaders(code?: string): Record<string, string> {
  return code ? { "x-access-code": code } : {};
}

function chatRequest(body: unknown, code?: string): NextRequest {
  return new NextRequest("http://localhost/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...requestHeaders(code) },
    body: JSON.stringify(body),
  });
}

function rawChatRequest(body: string): NextRequest {
  return new NextRequest("http://localhost/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
}

function resetRequest(body: unknown, code?: string): NextRequest {
  return new NextRequest("http://localhost/api/reset", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...requestHeaders(code) },
    body: JSON.stringify(body),
  });
}

function voiceRequest(formData: FormData, code?: string): NextRequest {
  return new NextRequest("http://localhost/api/voice", {
    method: "POST",
    headers: requestHeaders(code),
    body: formData,
  });
}

function audioForm(options?: {
  sessionId?: string;
  bytes?: number;
  duration?: string;
  speak?: boolean;
}): FormData {
  const size = options?.bytes ?? 64;
  const form = new FormData();
  form.append(
    "audio",
    new File([new Uint8Array(size)], "rec.webm", { type: "audio/webm" }),
  );
  form.append("session_id", options?.sessionId ?? nextSession());
  if (options?.duration !== undefined) {
    form.append("audio_duration", options.duration);
  }
  if (options?.speak !== undefined) {
    form.append("speak", String(options.speak));
  }
  return form;
}

async function bodyOf(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

function detailOf(body: Record<string, unknown>): { error_code?: string } {
  return (body.detail ?? {}) as { error_code?: string };
}

beforeEach(() => {
  vi.clearAllMocks();
  config.accessCode = "";
  config.rateLimitRequests = 1_000;
  config.dailyRequestBudget = 100_000;
});

describe("health", () => {
  it("reports status and version without exposing internals", async () => {
    const response = await getHealth(
      new NextRequest("http://localhost/api/health"),
    );
    const body = await bodyOf(response);

    expect(response.status).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.name).toBe("Voxen");
    expect(body.access_required).toBe(false);
    expect(body.checks).toBeUndefined();
    expect(body.budget).toBeUndefined();
    expect(body.sessions).toBeUndefined();
  });

  it("exposes configuration and budget on the detail view", async () => {
    const originalKey = config.openaiApiKey;
    config.openaiApiKey = "test-key";

    try {
      const response = await getHealth(
        new NextRequest("http://localhost/api/health?detail=1"),
      );
      const body = await bodyOf(response);

      expect(response.status).toBe(200);
      expect(body.checks).toMatchObject({ ai: "configured" });
      expect(body.budget).toMatchObject({ limit: config.dailyRequestBudget });
      expect(typeof body.sessions).toBe("number");
    } finally {
      config.openaiApiKey = originalKey;
    }
  });

  it("verifies an access code when asked", async () => {
    config.accessCode = "letmein";

    const denied = await getHealth(
      new NextRequest("http://localhost/api/health?verify=1"),
    );
    expect(denied.status).toBe(401);

    const allowed = await getHealth(
      new NextRequest("http://localhost/api/health?verify=1", {
        headers: { "x-access-code": "letmein" },
      }),
    );
    expect(allowed.status).toBe(200);
  });
});

describe("ready", () => {
  it("fails readiness when the AI provider is not configured", async () => {
    const originalKey = config.openaiApiKey;
    config.openaiApiKey = "";

    try {
      const response = await getReady();
      expect(response.status).toBe(503);
      expect(await bodyOf(response)).toMatchObject({
        status: "not_ready",
        reason: "ai_not_configured",
      });
    } finally {
      config.openaiApiKey = originalKey;
    }
  });

  it("reports readiness when the AI provider is configured", async () => {
    const originalKey = config.openaiApiKey;
    config.openaiApiKey = "test-key";

    try {
      const response = await getReady();
      expect(response.status).toBe(200);
      expect(await bodyOf(response)).toEqual({ status: "ready" });
    } finally {
      config.openaiApiKey = originalKey;
    }
  });

  it("fails readiness in production without a usable access gate", async () => {
    const originalKey = config.openaiApiKey;
    const originalProduction = config.isProduction;
    const originalCode = config.accessCode;
    config.openaiApiKey = "test-key";
    config.isProduction = true;
    config.accessCode = "";

    try {
      const response = await getReady();
      expect(response.status).toBe(503);
      expect(await bodyOf(response)).toMatchObject({
        status: "not_ready",
        reason: "access_code_not_configured",
      });
    } finally {
      config.openaiApiKey = originalKey;
      config.isProduction = originalProduction;
      config.accessCode = originalCode;
    }
  });
});

describe("chat", () => {
  it("returns a reply and persists history across turns", async () => {
    const sessionId = nextSession();
    mockGenerate.mockImplementation(async (messages) => {
      const count = messages.filter((message) => message.role === "user").length;
      return count === 1 ? "first reply" : "second reply";
    });

    const first = await postChat(
      chatRequest({ session_id: sessionId, message: "hi" }),
    );
    expect(first.status).toBe(200);
    expect((await bodyOf(first)).reply).toBe("first reply");

    const second = await postChat(
      chatRequest({ session_id: sessionId, message: "again" }),
    );
    const secondBody = await bodyOf(second);
    expect(second.status).toBe(200);
    expect(secondBody.reply).toBe("second reply");
    const history = secondBody.history as { content: string }[];
    expect(history.map((message) => message.content)).toEqual([
      "hi",
      "first reply",
      "again",
      "second reply",
    ]);
  });

  it("rejects blank messages", async () => {
    const response = await postChat(
      chatRequest({ session_id: nextSession(), message: "   " }),
    );
    expect(response.status).toBe(400);
    expect(detailOf(await bodyOf(response)).error_code).toBe("EMPTY_MESSAGE");
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it("rejects invalid session ids", async () => {
    const response = await postChat(
      chatRequest({ session_id: "bad id!", message: "hi" }),
    );
    expect(response.status).toBe(400);
    expect(detailOf(await bodyOf(response)).error_code).toBe("INVALID_SESSION");
  });

  it("does not persist an orphan user turn when the model fails", async () => {
    const sessionId = nextSession();
    mockGenerate.mockRejectedValue(new AppError("LLM_FAILED", "down", 502));

    const response = await postChat(
      chatRequest({ session_id: sessionId, message: "hello" }),
    );

    expect(response.status).toBe(502);
    expect(getHistory(sessionId)).toEqual([]);
  });

  it("speaks the reply when asked", async () => {
    mockGenerate.mockResolvedValue("spoken answer");
    mockSynthesize.mockResolvedValue("QUJD");

    const response = await postChat(
      chatRequest({ session_id: nextSession(), message: "hi", speak: true }),
    );
    const body = await bodyOf(response);

    expect(response.status).toBe(200);
    expect(body.audio).toBe("QUJD");
  });

  it("refuses paid traffic in production without an access gate", async () => {
    const originalProduction = config.isProduction;
    const originalCode = config.accessCode;
    config.isProduction = true;
    config.accessCode = "";

    try {
      const response = await postChat(
        chatRequest({ session_id: nextSession(), message: "hi" }),
      );
      expect(response.status).toBe(503);
      expect(detailOf(await bodyOf(response)).error_code).toBe("CONFIG_ERROR");
      expect(mockGenerate).not.toHaveBeenCalled();
    } finally {
      config.isProduction = originalProduction;
      config.accessCode = originalCode;
    }
  });

  it("enforces the access code when configured", async () => {
    config.accessCode = "letmein";
    const sessionId = nextSession();

    const denied = await postChat(
      chatRequest({ session_id: sessionId, message: "hi" }),
    );
    expect(denied.status).toBe(401);
    expect(detailOf(await bodyOf(denied)).error_code).toBe("ACCESS_DENIED");

    mockGenerate.mockResolvedValue("ok");
    const allowed = await postChat(
      chatRequest({ session_id: sessionId, message: "hi" }, "letmein"),
    );
    expect(allowed.status).toBe(200);
  });

  it("enforces the daily budget", async () => {
    const original = config.dailyRequestBudget;
    config.dailyRequestBudget = 0;

    try {
      const response = await postChat(
        chatRequest({ session_id: nextSession(), message: "hi" }),
      );
      expect(response.status).toBe(429);
      expect(detailOf(await bodyOf(response)).error_code).toBe(
        "BUDGET_EXHAUSTED",
      );
      expect(mockGenerate).not.toHaveBeenCalled();
    } finally {
      config.dailyRequestBudget = original;
    }
  });

  it("rejects request bodies above the configured byte limit", async () => {
    const original = config.maxChatRequestBytes;
    config.maxChatRequestBytes = 32;

    try {
      const response = await postChat(
        chatRequest({ session_id: nextSession(), message: "x".repeat(100) }),
      );
      expect(response.status).toBe(413);
      expect(detailOf(await bodyOf(response)).error_code).toBe(
        "PAYLOAD_TOO_LARGE",
      );
      expect(mockGenerate).not.toHaveBeenCalled();
    } finally {
      config.maxChatRequestBytes = original;
    }
  });

  it("rejects malformed JSON", async () => {
    const response = await postChat(rawChatRequest("{not-json"));
    expect(response.status).toBe(400);
    expect(detailOf(await bodyOf(response)).error_code).toBe("INVALID_BODY");
  });
});

describe("history", () => {
  it("returns the stored history for a session", async () => {
    const sessionId = nextSession();
    mockGenerate.mockResolvedValue("stored reply");
    await postChat(chatRequest({ session_id: sessionId, message: "remember" }));

    const response = await getHistoryRoute(
      new NextRequest(
        `http://localhost/api/history?session_id=${sessionId}`,
      ),
    );
    const body = await bodyOf(response);

    expect(response.status).toBe(200);
    expect(body.history).toEqual([
      { role: "user", content: "remember" },
      { role: "assistant", content: "stored reply" },
    ]);
  });

  it("accepts the session id in a header", async () => {
    const sessionId = nextSession();
    mockGenerate.mockResolvedValue("header reply");
    await postChat(chatRequest({ session_id: sessionId, message: "again" }));

    const response = await getHistoryRoute(
      new NextRequest("http://localhost/api/history", {
        headers: { "x-session-id": sessionId },
      }),
    );
    const body = await bodyOf(response);

    expect(response.status).toBe(200);
    expect(body.session_id).toBe(sessionId);
    expect(body.history).toEqual([
      { role: "user", content: "again" },
      { role: "assistant", content: "header reply" },
    ]);
  });

  it("requires a valid session id", async () => {
    const response = await getHistoryRoute(
      new NextRequest("http://localhost/api/history"),
    );
    expect(response.status).toBe(400);
    expect(detailOf(await bodyOf(response)).error_code).toBe("MISSING_SESSION");
  });
});

describe("reset", () => {
  it("clears only the target session", async () => {
    const sessionA = nextSession();
    const sessionB = nextSession();
    mockGenerate.mockResolvedValue("ok");

    await postChat(chatRequest({ session_id: sessionA, message: "hi" }));
    await postChat(chatRequest({ session_id: sessionB, message: "bye" }));

    const response = await postReset(resetRequest({ session_id: sessionA }));
    expect(response.status).toBe(200);
    expect(getHistory(sessionA)).toEqual([]);
    expect(getHistory(sessionB)).toHaveLength(2);
  });

  it("requires a session id", async () => {
    const response = await postReset(resetRequest({}));
    expect(response.status).toBe(400);
    expect(detailOf(await bodyOf(response)).error_code).toBe("MISSING_SESSION");
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

  it("skips speech when speak is false", async () => {
    mockTranscribe.mockResolvedValue("hello");
    mockGenerate.mockResolvedValue("hi there");

    const response = await postVoice(
      voiceRequest(audioForm({ speak: false })),
    );
    const body = await bodyOf(response);

    expect(response.status).toBe(200);
    expect(body.audio).toBeNull();
    expect(mockSynthesize).not.toHaveBeenCalled();
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
    expect(detailOf(await bodyOf(response)).error_code).toBe("EMPTY_AUDIO");
  });

  it("rejects oversized audio", async () => {
    const response = await postVoice(
      voiceRequest(audioForm({ bytes: 4.2 * 1024 * 1024 })),
    );
    expect(response.status).toBe(413);
    expect(detailOf(await bodyOf(response)).error_code).toBe("AUDIO_TOO_LARGE");
  });

  it("rejects a request body above the transport limit", async () => {
    const response = await postVoice(
      voiceRequest(audioForm({ bytes: 12 * 1024 * 1024 })),
    );
    expect(response.status).toBe(413);
    expect(detailOf(await bodyOf(response)).error_code).toBe(
      "PAYLOAD_TOO_LARGE",
    );
  });

  it("rejects overly long audio", async () => {
    const response = await postVoice(
      voiceRequest(audioForm({ duration: "999" })),
    );
    expect(response.status).toBe(413);
    expect(detailOf(await bodyOf(response)).error_code).toBe("AUDIO_TOO_LONG");
  });

  it("rejects audio with no detected speech", async () => {
    mockTranscribe.mockResolvedValue("   ");
    const response = await postVoice(voiceRequest(audioForm()));
    expect(response.status).toBe(400);
    expect(detailOf(await bodyOf(response)).error_code).toBe("NOTHING_HEARD");
  });

  it("maps STT failures to 502", async () => {
    mockTranscribe.mockRejectedValue(
      new AppError("STT_FAILED", "bad key", 502),
    );
    const response = await postVoice(voiceRequest(audioForm()));
    expect(response.status).toBe(502);
    expect(detailOf(await bodyOf(response)).error_code).toBe("STT_FAILED");
  });
});
