import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { POST as postToken } from "@/app/api/realtime/token/route";
import { POST as postUsage } from "@/app/api/realtime/usage/route";
import { config } from "@/lib/config";
import { budgetSnapshot } from "@/lib/ratelimit";
import {
  realtimeUsageSnapshot,
  resetRealtimeBudget,
} from "@/lib/realtime-budget";

let counter = 0;

function session(): string {
  counter += 1;
  return `realtime-session-${counter}`;
}

function request(path: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function bodyOf(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

beforeEach(() => {
  counter = 0;
  resetRealtimeBudget();
  config.openaiApiKey = "test-key";
  config.accessCode = "";
  config.rateLimitRequests = 10_000;
  config.dailyRequestBudget = 100_000;
  config.realtimeEnabled = true;
  config.realtimeModel = "gpt-realtime-2.1-mini";
  config.realtimeVoice = "marin";
  config.realtimeMaxSessions = 3;
  config.realtimeMaxAudioSeconds = 180;
  config.realtimeMaxOutputTokens = 4_000;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("realtime token route", () => {
  it("is disabled unless explicitly enabled", async () => {
    config.realtimeEnabled = false;
    const response = await postToken(request("/api/realtime/token", { session_id: session() }));

    expect(response.status).toBe(503);
    expect(await bodyOf(response)).toMatchObject({
      detail: { error_code: "CONFIG_ERROR" },
    });
  });

  it("mints an ephemeral secret without exposing the standard key", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ value: "ek_test", expires_at: "later" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const id = session();
    const response = await postToken(
      request("/api/realtime/token", { session_id: id }),
    );
    const body = await bodyOf(response);

    expect(response.status).toBe(200);
    expect(body.value).toBe("ek_test");
    expect(body.model).toBe("gpt-realtime-2.1-mini");
    expect(body.limits).toMatchObject({ audio_seconds: 180, output_tokens: 4_000 });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/realtime/client_secrets");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-key");
    expect(headers["OpenAI-Safety-Identifier"]).toMatch(/^sha256:/);
    expect(String(init.body)).not.toContain("test-key");

    const policy = JSON.parse(String(init.body)) as {
      session: {
        audio: {
          input: {
            transcription: { model: string };
            turn_detection: { type: string; interrupt_response: boolean };
          };
        };
      };
    };
    expect(policy.session.audio.input.transcription.model).toBe("gpt-transcribe");
    expect(policy.session.audio.input.turn_detection).toMatchObject({
      type: "server_vad",
      interrupt_response: true,
    });
    expect(realtimeUsageSnapshot(id)?.sessions).toBe(1);
  });

  it("refunds the reservation when the provider rejects the request", async () => {
    const usedBefore = budgetSnapshot().used;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("unauthorized", { status: 401 })),
    );

    const id = session();
    const response = await postToken(
      request("/api/realtime/token", { session_id: id }),
    );

    expect(response.status).toBe(502);
    expect(await bodyOf(response)).toMatchObject({
      detail: { error_code: "REALTIME_FAILED" },
    });
    expect(realtimeUsageSnapshot(id)).toBeNull();
    expect(budgetSnapshot().used).toBe(usedBefore);
  });

  it("enforces a per-session concurrent session cap", async () => {
    config.realtimeMaxSessions = 1;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ value: "ek_test" }), { status: 200 }),
      ),
    );

    const id = session();
    expect(
      (await postToken(request("/api/realtime/token", { session_id: id }))).status,
    ).toBe(200);
    const second = await postToken(
      request("/api/realtime/token", { session_id: id }),
    );
    expect(second.status).toBe(429);
    expect(realtimeUsageSnapshot(id)?.sessions).toBe(1);
  });
});

describe("realtime usage route", () => {
  it("records audio and token usage within limits", async () => {
    const id = session();
    const response = await postUsage(
      request("/api/realtime/usage", {
        session_id: id,
        audio_seconds: 42.5,
        output_tokens: 300,
      }),
    );

    expect(response.status).toBe(200);
    expect(await bodyOf(response)).toMatchObject({
      usage: { audioSeconds: 42.5, outputTokens: 300 },
    });
  });

  it("rejects usage beyond the audio-minute cap", async () => {
    const response = await postUsage(
      request("/api/realtime/usage", {
        session_id: session(),
        audio_seconds: 181,
      }),
    );

    expect(response.status).toBe(429);
    expect(await bodyOf(response)).toMatchObject({
      detail: { error_code: "BUDGET_EXHAUSTED" },
    });
  });
});
