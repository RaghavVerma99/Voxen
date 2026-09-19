import { describe, expect, it } from "vitest";
import { reset, getHistory, addMessage } from "@/lib/conversation";
import { searchWeb, runTool } from "@/lib/tools";
import { config } from "@/lib/config";

describe("conversation", () => {
  it("isolates history between sessions", () => {
    addMessage("a", "user", "hello");
    addMessage("b", "user", "bye");
    reset("a");
    expect(getHistory("a")).toEqual([]);
    expect(getHistory("b").map((m) => m.content)).toEqual(["bye"]);
  });

  it("caps history at maxHistoryMessages plus the system prompt", () => {
    const sessionId = "cap";
    const cap = config.maxHistoryMessages;
    for (let i = 0; i < cap + 10; i += 1) {
      addMessage(sessionId, "user", `msg-${i}`);
    }
    expect(getHistory(sessionId)).toHaveLength(cap);
    expect(getHistory(sessionId)[0].content).toBe("msg-10");
    expect(getHistory(sessionId)[cap - 1].content).toBe(`msg-${cap + 9}`);
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

    const original = globalThis.fetch;
    globalThis.fetch = fakeFetch as typeof fetch;

    try {
      const result = await runTool("search_web", '{"query": "latest postgresql release"}');
      expect(captured[0]).toContain("q=latest%20postgresql%20release");
      const parsed = JSON.parse(result);
      expect(parsed[0]).toMatchObject({
        title: "Example",
        url: "https://example.com/",
        body: "A snippet.",
      });
    } finally {
      globalThis.fetch = original;
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