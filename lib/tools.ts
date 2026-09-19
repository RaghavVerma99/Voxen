import { load } from "cheerio";
import { config } from "./config";

export interface ToolSchema {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export const TOOL_SCHEMAS: ToolSchema[] = [
  {
    type: "function",
    function: {
      name: "search_web",
      description:
        "Search the web and return current, up-to-date information. Use this for questions about recent events, latest releases, prices, or anything that may have changed after the model's training cutoff.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "The search query the user is asking about.",
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
];

const MAX_RESULTS = 5;

function decodeBounce(href: string): string | null {
  const match = href.match(/[?&]uddg=([^&]+)/);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

export async function searchWeb(query: string): Promise<string> {
  if (!query.trim()) {
    return JSON.stringify({ error: "empty query" });
  }
  try {
    const url = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`;
    const response = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36",
      },
      signal: AbortSignal.timeout(config.searchTimeoutMs),
    });
    if (!response.ok) {
      return JSON.stringify({ error: `search failed: HTTP ${response.status}` });
    }
    const $ = load(await response.text());
    const results: { title: string; url: string; body: string }[] = [];
    $('a[rel="nofollow"]').each((_, el) => {
      const href = $(el).attr("href") ?? "";
      const target = decodeBounce(href);
      if (!target) return;
      const title = $(el).text().trim();
      if (!title) return;
      const body = $(el)
        .closest("tr")
        .next("tr")
        .find("td.result-snippet")
        .text()
        .trim();
      results.push({ title, url: target, body });
    });
    const unique = results.filter(
      (result, index) => results.findIndex((other) => other.url === result.url) === index,
    );
    if (unique.length === 0) {
      return JSON.stringify({ error: "no results" });
    }
    return JSON.stringify(unique.slice(0, MAX_RESULTS));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return JSON.stringify({ error: `search failed: ${message}` });
  }
}

export function runTool(name: string, argumentsJson: string): Promise<string> {
  if (name === "search_web") {
    let query = "";
    try {
      const args = JSON.parse(argumentsJson || "{}");
      query = typeof args.query === "string" ? args.query : "";
    } catch {
      query = "";
    }
    return searchWeb(query);
  }
  return Promise.resolve(JSON.stringify({ error: `unknown tool: ${name}` }));
}