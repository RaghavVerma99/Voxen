import { beforeEach, describe, expect, it, vi } from "vitest";

const provider = vi.hoisted(() => ({
  createChat: vi.fn(),
  createSpeech: vi.fn(),
  createTranscription: vi.fn(),
}));

const wsState = vi.hoisted(() => ({ instances: [] as Array<Record<string, unknown>> }));

vi.mock("ws", () => ({
  default: class FakeWebSocket {
    handlers: Record<string, Array<(...args: unknown[]) => void>> = {};
    sent: string[] = [];
    readyState = 1;
    url: string;
    options: { headers?: Record<string, string> };

    constructor(url: string, options?: { headers?: Record<string, string> }) {
      this.url = url;
      this.options = options ?? {};
      wsState.instances.push(this as unknown as Record<string, unknown>);
    }

    on(event: string, listener: (...args: unknown[]) => void): void {
      this.handlers[event] = [...(this.handlers[event] ?? []), listener];
    }

    off(event: string, listener: (...args: unknown[]) => void): void {
      this.handlers[event] = (this.handlers[event] ?? []).filter(
        (candidate) => candidate !== listener,
      );
    }

    send(data: string): void {
      this.sent.push(data);
    }

    close(): void {
      this.readyState = 3;
      for (const listener of [...(this.handlers["close"] ?? [])]) {
        listener(1000, Buffer.alloc(0), true);
      }
    }

    emit(event: string, ...args: unknown[]): void {
      for (const listener of [...(this.handlers[event] ?? [])]) {
        listener(...args);
      }
    }
  },
}));

vi.mock("openai", () => ({
  default: vi.fn(function OpenAI() {
    return {
      chat: { completions: { create: provider.createChat } },
      audio: {
        transcriptions: { create: provider.createTranscription },
        speech: { create: provider.createSpeech },
      },
    };
  }),
}));

import {
  generateResponse,
  synthesizeSpeech,
  transcribeAudio,
} from "@/lib/ai";
import { synthesizeSpeechRealtime } from "@/lib/realtime-tts";
import { config } from "@/lib/config";
import { AppError } from "@/lib/errors";

function textReply(content: string) {
  return { choices: [{ message: { content, tool_calls: null } }] };
}

function toolReply(name = "search_web", args = '{"query":"latest news"}') {
  return {
    choices: [
      {
        message: {
          content: null,
          tool_calls: [
            {
              id: "call-1",
              type: "function",
              function: { name, arguments: args },
            },
          ],
        },
      },
    ],
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  wsState.instances.length = 0;
  config.openaiApiKey = "test-key";
  config.maxToolRounds = 4;
  config.searchProvider = "duckduckgo";
  config.ttsProvider = "speech";
  config.ttsFallbackProvider = "none";
});

describe("transcribeAudio", () => {
  it("reads the JSON transcript and trims it", async () => {
    provider.createTranscription.mockResolvedValue({ text: "  hello world  " });
    const file = new File([new Uint8Array(8)], "clip.webm", {
      type: "audio/webm",
    });

    await expect(transcribeAudio(file)).resolves.toBe("hello world");

    const request = provider.createTranscription.mock.calls[0][0] as {
      response_format?: string;
    };
    expect(request.response_format).toBe("json");
  });

  it("maps provider failures to STT_FAILED", async () => {
    provider.createTranscription.mockRejectedValue(new Error("upstream down"));
    const file = new File([new Uint8Array(8)], "clip.webm", {
      type: "audio/webm",
    });

    await expect(transcribeAudio(file)).rejects.toMatchObject({
      code: "STT_FAILED",
      status: 502,
    });
  });
});

describe("generateResponse", () => {
  it("returns plain text replies", async () => {
    provider.createChat.mockResolvedValue(textReply("Hello there."));

    await expect(
      generateResponse([{ role: "user", content: "hi" }]),
    ).resolves.toBe("Hello there.");
    expect(provider.createChat).toHaveBeenCalledTimes(1);
  });

  it("uses completion-token limits and disables reasoning for tool calls", async () => {
    provider.createChat.mockResolvedValue(textReply("ok"));

    await generateResponse([{ role: "user", content: "hi" }]);

    const request = provider.createChat.mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(request.max_completion_tokens).toBe(config.maxReplyTokens);
    expect(request.max_tokens).toBeUndefined();
    expect(request.reasoning_effort).toBe("none");
  });

  it("omits reasoning_effort when reasoning is disabled", async () => {
    const original = config.llmReasoningEffort;
    config.llmReasoningEffort = null;
    provider.createChat.mockResolvedValue(textReply("ok"));

    try {
      await generateResponse([{ role: "user", content: "hi" }]);
      const request = provider.createChat.mock.calls[0][0] as Record<
        string,
        unknown
      >;
      expect(request.reasoning_effort).toBeUndefined();
    } finally {
      config.llmReasoningEffort = original;
    }
  });

  it("falls back to a retry prompt on empty content", async () => {
    provider.createChat.mockResolvedValue(textReply("   "));

    const reply = await generateResponse([{ role: "user", content: "hi" }]);
    expect(reply).toContain("say it again");
  });

  it("executes a tool call and answers with the result", async () => {
    provider.createChat
      .mockResolvedValueOnce(toolReply())
      .mockResolvedValueOnce(textReply("Here is the summary."));

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        "<html><table><tr><td><a rel='nofollow' href='//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2F'>Example</a></td></tr>" +
          "<tr><td></td><td class='result-snippet'>Snippet.</td></tr></table></html>",
        { status: 200 },
      )) as typeof fetch;

    try {
      const reply = await generateResponse([{ role: "user", content: "news?" }]);
      expect(reply).toBe("Here is the summary.");
      expect(provider.createChat).toHaveBeenCalledTimes(2);

      const secondRequest = provider.createChat.mock.calls[1][0] as {
        messages: Array<{ role: string; content?: string }>;
      };
      const toolMessage = secondRequest.messages.find(
        (message) => message.role === "tool",
      );
      expect(toolMessage?.content).toContain("example.com");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("reports executed tool names to an optional observer", async () => {
    provider.createChat
      .mockResolvedValueOnce(toolReply())
      .mockResolvedValueOnce(textReply("Done."));
    const onToolCall = vi.fn();

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response("<html></html>", { status: 200 })) as typeof fetch;

    try {
      await generateResponse(
        [{ role: "user", content: "news?" }],
        {},
        { onToolCall },
      );
      expect(onToolCall).toHaveBeenCalledWith("search_web");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("fails when the tool loop exceeds its bound", async () => {
    config.maxToolRounds = 1;
    provider.createChat.mockResolvedValue(toolReply());

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response("<html></html>", { status: 200 })) as typeof fetch;

    try {
      await expect(
        generateResponse([{ role: "user", content: "loop" }]),
      ).rejects.toMatchObject({ code: "LLM_FAILED" });
      expect(provider.createChat).toHaveBeenCalledTimes(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("rejects non-function tool calls", async () => {
    provider.createChat.mockResolvedValue({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [{ id: "call-1", type: "custom" }],
          },
        },
      ],
    });

    await expect(
      generateResponse([{ role: "user", content: "hi" }]),
    ).rejects.toBeInstanceOf(AppError);
  });
});

describe("synthesizeSpeech", () => {
  it("returns base64 audio", async () => {
    provider.createSpeech.mockResolvedValue({
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    });

    await expect(synthesizeSpeech("hello")).resolves.toBe("AQID");
  });

  it("requests a WAV container from the speech provider", async () => {
    provider.createSpeech.mockResolvedValue({
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    });

    await synthesizeSpeech("hello");

    const request = provider.createSpeech.mock.calls[0][0] as {
      model?: string;
      voice?: string;
      response_format?: string;
      input?: string;
    };
    expect(request.response_format).toBe("wav");
  });

  it("truncates input to the provider limit", async () => {
    provider.createSpeech.mockResolvedValue({
      arrayBuffer: async () => new ArrayBuffer(2),
    });

    await synthesizeSpeech("x".repeat(10_000));

    const input = (provider.createSpeech.mock.calls[0][0] as { input: string })
      .input;
    expect(input.length).toBeLessThanOrEqual(4_000);
    expect(input.endsWith("...")).toBe(true);
  });

  it("falls back to the realtime adapter when speech fails", async () => {
    config.ttsProvider = "speech";
    config.ttsFallbackProvider = "realtime";
    provider.createSpeech.mockRejectedValue(new Error("legacy down"));

    const audioPromise = synthesizeSpeech("fallback please");
    // Let the rejected primary settle so the failover adapter is entered.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const instance = wsState.instances[wsState.instances.length - 1] as {
      sent: string[];
      emit: (event: string, ...args: unknown[]) => void;
    };

    instance.emit(
      "message",
      Buffer.from(JSON.stringify({ type: "session.created" })),
    );
    instance.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "response.output_audio.delta",
          delta: Buffer.from([1, 2, 3, 4]).toString("base64"),
        }),
      ),
    );
    instance.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "response.done",
          response: { status: "completed" },
        }),
      ),
    );

    const audio = await audioPromise;
    expect(provider.createSpeech).toHaveBeenCalledTimes(1);
    expect(instance.sent[1]).toContain("fallback please");
    expect(Buffer.from(audio, "base64").subarray(0, 4).toString("ascii")).toBe(
      "RIFF",
    );
  });

  it("stops after the primary when fallback is disabled", async () => {
    config.ttsProvider = "speech";
    config.ttsFallbackProvider = "none";
    provider.createSpeech.mockRejectedValue(new Error("legacy down"));

    await expect(synthesizeSpeech("hello")).rejects.toMatchObject({
      code: "TTS_FAILED",
      status: 502,
    });
    expect(provider.createSpeech).toHaveBeenCalledTimes(1);
    expect(wsState.instances).toHaveLength(0);
  });

  it("does not retry a cancelled speech request", async () => {
    config.ttsProvider = "speech";
    config.ttsFallbackProvider = "realtime";
    const aborted = Object.assign(new Error("cancelled"), {
      name: "AbortError",
    });
    provider.createSpeech.mockRejectedValue(aborted);

    await expect(synthesizeSpeech("hello")).rejects.toBe(aborted);
    expect(wsState.instances).toHaveLength(0);
  });
});

describe("synthesizeSpeechRealtime", () => {
  it("migrates narration to the realtime TTS model and returns WAV audio", async () => {
    config.ttsProvider = "realtime";

    const audioPromise = synthesizeSpeechRealtime("Hello there.");
    const instance = wsState.instances[wsState.instances.length - 1] as {
      sent: string[];
      handlers: Record<string, Array<(event: unknown, ...args: unknown[]) => void>>;
      emit: (event: string, ...args: unknown[]) => void;
      close: () => void;
    };

    instance.emit(
      "message",
      Buffer.from(JSON.stringify({ type: "session.created" })),
    );
    instance.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "response.output_audio.delta",
          delta: Buffer.from([1, 2, 3, 4]).toString("base64"),
        }),
      ),
    );
    instance.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "response.done",
          response: { status: "completed" },
        }),
      ),
    );

    const audio = await audioPromise;

    expect(instance.sent[0]).toContain('"type":"session.update"');
    expect(instance.sent[0]).toContain('"output_modalities":["audio"]');
    expect(instance.sent[1]).toContain('"type":"conversation.item.create"');
    expect(instance.sent[1]).toContain('"input_text"');
    expect(instance.sent[2]).toContain('"type":"response.create"');
    expect(instance.sent[2]).toContain('"output_modalities":["audio"]');

    const wav = Buffer.from(audio, "base64");
    expect(wav.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(wav.subarray(8, 12).toString("ascii")).toBe("WAVE");
  });

  it("maps realtime failures to TTS_FAILED", async () => {
    config.ttsProvider = "realtime";

    const audioPromise = synthesizeSpeechRealtime("Hello there.");
    const instance = wsState.instances[wsState.instances.length - 1] as {
      emit: (event: string, ...args: unknown[]) => void;
    };
    instance.emit("error", new Error("realtime down"));

    await expect(audioPromise).rejects.toMatchObject({
      code: "TTS_FAILED",
      status: 502,
    });
  });
});
