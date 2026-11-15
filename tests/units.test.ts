import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { addMessage, appendTurn, getHistory, reset } from "@/lib/conversation";
import { config } from "@/lib/config";
import { AppError } from "@/lib/errors";
import { clientAddress, guardRequest } from "@/lib/guard";
import { rateLimit } from "@/lib/ratelimit";
import { withSessionLock } from "@/lib/session-lock";
import { SentenceChunker } from "@/lib/sse";
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

describe("session lock", () => {
  it("serializes work for the same session", async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = withSessionLock("lock-session", async () => {
      order.push("first:start");
      await gate;
      order.push("first:end");
    });
    const second = withSessionLock("lock-session", async () => {
      order.push("second:start");
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(order).toEqual(["first:start"]);

    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second:start"]);
  });

  it("does not block other sessions", async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = withSessionLock("lock-a", async () => {
      order.push("a:start");
      await gate;
    });
    const second = withSessionLock("lock-b", async () => {
      order.push("b:start");
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(order.sort()).toEqual(["a:start", "b:start"]);

    release();
    await Promise.all([first, second]);
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

describe("access guard", () => {
  it("counts failed access attempts before rejecting them", () => {
    const originalCode = config.accessCode;
    const originalLimit = config.rateLimitRequests;
    const route = uniqueId("guard");
    config.accessCode = "secret";
    config.rateLimitRequests = 1;

    try {
      const request = () =>
        new NextRequest("http://localhost/api/chat", {
          headers: { "x-access-code": "wrong" },
        });

      expect(() => guardRequest(request(), route)).toThrow(
        expect.objectContaining({ code: "ACCESS_DENIED" }),
      );
      expect(() => guardRequest(request(), route)).toThrow(
        expect.objectContaining({ code: "RATE_LIMITED" }),
      );
    } finally {
      config.accessCode = originalCode;
      config.rateLimitRequests = originalLimit;
    }
  });

  it("includes rate limit headers on access denials", () => {
    const originalCode = config.accessCode;
    const originalLimit = config.rateLimitRequests;
    config.accessCode = "secret";
    config.rateLimitRequests = 10;

    try {
      try {
        guardRequest(
          new NextRequest("http://localhost/api/chat"),
          uniqueId("guard-headers"),
        );
        expect.unreachable("guardRequest should reject a missing code");
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).headers).toMatchObject({
          "RateLimit-Limit": "10",
        });
      }
    } finally {
      config.accessCode = originalCode;
      config.rateLimitRequests = originalLimit;
    }
  });

  it("fails closed in production when the access gate is missing or weak", () => {
    const originalProduction = config.isProduction;
    const originalCode = config.accessCode;
    const originalRequired = config.requireAccessCodeInProduction;

    try {
      config.isProduction = true;
      config.requireAccessCodeInProduction = true;
      config.accessCode = "";

      expect(() =>
        guardRequest(
          new NextRequest("http://localhost/api/chat"),
          uniqueId("prod-guard"),
        ),
      ).toThrow(expect.objectContaining({ code: "CONFIG_ERROR", status: 503 }));

      config.accessCode = "too-short";
      expect(() =>
        guardRequest(
          new NextRequest("http://localhost/api/chat"),
          uniqueId("short-guard"),
        ),
      ).toThrow(expect.objectContaining({ code: "CONFIG_ERROR" }));

      config.accessCode = "x".repeat(config.minAccessCodeLength);
      expect(() =>
        guardRequest(
          new NextRequest("http://localhost/api/chat", {
            headers: { "x-access-code": config.accessCode },
          }),
          uniqueId("valid-guard"),
        ),
      ).not.toThrow();
    } finally {
      config.isProduction = originalProduction;
      config.accessCode = originalCode;
      config.requireAccessCodeInProduction = originalRequired;
    }
  });

  it("ignores forwarded headers unless a proxy is trusted", () => {
    const originalHops = config.trustProxyHops;
    const headers = { "x-forwarded-for": "203.0.113.9, 10.0.0.1" };

    try {
      config.trustProxyHops = 0;
      expect(
        clientAddress(new NextRequest("http://localhost", { headers })),
      ).toBe("local");

      config.trustProxyHops = 1;
      expect(
        clientAddress(new NextRequest("http://localhost", { headers })),
      ).toBe("10.0.0.1");
    } finally {
      config.trustProxyHops = originalHops;
    }
  });
});

describe("sentence chunking", () => {
  it("splits complete sentences as they arrive", () => {
    const chunker = new SentenceChunker();
    expect(chunker.push("First sentence. ")).toEqual(["First sentence."]);
    expect(chunker.push("Second one! ")).toEqual(["Second one!"]);
    expect(chunker.flush()).toEqual([]);
  });

  it("keeps an incomplete tail buffered until flush", () => {
    const chunker = new SentenceChunker();
    expect(chunker.push("No punctuation yet")).toEqual([]);
    expect(chunker.push(" and still going")).toEqual([]);
    expect(chunker.flush()).toEqual(["No punctuation yet and still going"]);
  });

  it("keeps closing quotes with their sentence", () => {
    const chunker = new SentenceChunker();
    expect(chunker.push('He said "hello." ')).toEqual(['He said "hello."']);
  });

  it("splits long unpunctuated text into speakable chunks", () => {
    const chunker = new SentenceChunker();
    const chunks = chunker.push("word ".repeat(120));
    const flushed = chunker.flush();
    const all = [...chunks, ...flushed];

    expect(all.length).toBeGreaterThan(1);
    for (const chunk of all) expect(chunk.length).toBeLessThanOrEqual(260);
    expect(all.join(" ")).toContain("word");
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
