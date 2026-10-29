import { beforeEach, describe, expect, it, vi } from "vitest";

const provider = vi.hoisted(() => ({
  createChat: vi.fn(),
  createSpeech: vi.fn(),
  createTranscription: vi.fn(),
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

beforeEach(() => {
  vi.clearAllMocks();
  config.openaiApiKey = "test-key";
  config.maxToolRounds = 4;
  config.searchProvider = "duckduckgo";
});

describe("transcribeAudio", () => {
  it("returns the trimmed transcript", async () => {
    provider.createTranscription.mockResolvedValue("  hello world  ");
    const file = new File([new Uint8Array(8)], "clip.webm", {
      type: "audio/webm",
    });

    await expect(transcribeAudio(file)).resolves.toBe("hello world");
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
});
