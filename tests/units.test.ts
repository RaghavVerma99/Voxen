import { describe, expect, it } from "vitest";
import { addMessage, appendTurn, getHistory, reset } from "@/lib/conversation";
import { config } from "@/lib/config";
import { rateLimit } from "@/lib/ratelimit";
import { searchWeb, runTool } from "@/lib/tools";
import { requireSessionId, resolveSessionId } from "@/lib/validate";

let counter = 0;
function uniqueId(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}-${Date.now()}`;
}

describe("conversation", () => {
  it("isolates history between sessions", () => {
    const a = uniqueId("a");
    const b = uniqueId("b");

    addMessage(a, "user", "hello");
    addMessage(b, "user", "bye");
    reset(a);

    expect(getHistory(a)).toEqual([]);
    expect(getHistory(b).map((message) => message.content)).toEqual(["bye"]);
  });

  it("commits a completed turn atomically", () => {
    const sessionId = uniqueId("turn");
    appendTurn(sessionId, "question", "answer");

    expect(getHistory(sessionId).map((message) => message.content)).toEqual([
      "question",
      "answer",
    ]);
  });

  it("caps history at maxHistoryMessages plus the system prompt", () => {
    const sessionId = uniqueId("cap");
    const cap = config.maxHistoryMessages;

    for (let index = 0; index < cap + 10; index += 1) {
      addMessage(sessionId, "user", `msg-${index}`);
    }

    const history = getHistory(sessionId);
    expect(history).toHaveLength(cap);
    expect(history[0].content).toBe("msg-10");
    expect(history[cap - 1].content).toBe(`msg-${cap + 9}`);
  });

  it("never leaves the history starting with an assistant reply", () => {
    const sessionId = uniqueId("trim");
    const cap = config.maxHistoryMessages;

    for (let index = 0; index < cap; index += 1) {
      appendTurn(sessionId, `q-${index}`, `a-${index}`);
    }

    const history = getHistory(sessionId);
    expect(history.length).toBeGreaterThan(0);
    expect(history[0].role).toBe("user");
  });
});

describe("session ids", () => {
  it("accepts url-safe ids and rejects malformed ones", () => {
    expect(resolveSessionId("good-id_123")).toBe("good-id_123");
    expect(() => resolveSessionId("bad id!")).toThrow();
    expect(() => requireSessionId(undefined)).toThrow();
  });

  it("generates an id when one is missing", () => {
    const generated = resolveSessionId(undefined);
    expect(generated.length).toBeGreaterThan(0);
    expect(resolveSessionId(generated)).toBe(generated);
  });
});

describe("rate limiting", () => {
  it("blocks requests past the configured window limit", () => {
    const original = config.rateLimitRequests;
    config.rateLimitRequests = 2;

    try {
      const key = uniqueId("rl");
      expect(rateLimit(key).allowed).toBe(true);
      expect(rateLimit(key).allowed).toBe(true);

      const blocked = rateLimit(key);
      expect(blocked.allowed).toBe(false);
      expect(blocked.remaining).toBe(0);
      expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
    } finally {
      config.rateLimitRequests = original;
    }
  });
});

describe("tools", () => {
  it("dispatches search_web with the parsed query", async () => {
    const captured: string[] = [];

    function fakeFetch(input: RequestInfo | URL): Promise<Response> {
      captured.push(String(input));
      return Promise.resolve(
        new Response(
          "<html><table><tr><td><a rel='nofollow' href='//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2F' class='result-link'>Example</a></td></tr>" +
            "<tr><td></td><td class='result-snippet'>A snippet.</td></tr></table></html>",
          { status: 200 },
        ),
      );
    }

    const originalFetch = globalThis.fetch;
    const originalProvider = config.searchProvider;
    globalThis.fetch = fakeFetch as typeof fetch;
    config.searchProvider = "duckduckgo";

    try {
      const result = await runTool(
        "search_web",
        '{"query": "latest postgresql release"}',
      );
      expect(captured[0]).toContain("q=latest%20postgresql%20release");
      const parsed = JSON.parse(result);
      expect(parsed[0]).toMatchObject({
        title: "Example",
        url: "https://example.com/",
        body: "A snippet.",
      });
    } finally {
      globalThis.fetch = originalFetch;
      config.searchProvider = originalProvider;
    }
  });

  it("uses Tavily when configured", async () => {
    const originalFetch = globalThis.fetch;
    const originalProvider = config.searchProvider;
    const originalKey = config.tavilyApiKey;
    let capturedBody = "";

    const fakeFetch = (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      capturedBody = String(init?.body ?? "");
      return Promise.resolve(
        new Response(
          JSON.stringify({
            results: [
              { title: "Example", url: "https://example.com/", content: "Body" },
            ],
          }),
          { status: 200 },
        ),
      );
    };

    globalThis.fetch = fakeFetch as typeof fetch;
    config.searchProvider = "tavily";
    config.tavilyApiKey = "test-key";

    try {
      const result = await searchWeb("hello");
      expect(JSON.parse(result)[0]).toMatchObject({
        title: "Example",
        url: "https://example.com/",
        body: "Body",
      });
      expect(capturedBody).toContain('"query":"hello"');
    } finally {
      globalThis.fetch = originalFetch;
      config.searchProvider = originalProvider;
      config.tavilyApiKey = originalKey;
    }
  });

  it("returns an error payload for unknown tools", async () => {
    const result = await runTool("nope", "{}");
    expect(JSON.parse(result).error).toContain("unknown tool");
  });

  it("returns an error payload for empty queries", async () => {
    const result = await searchWeb("   ");
    expect(JSON.parse(result).error).toBe("empty query");
  });
});
