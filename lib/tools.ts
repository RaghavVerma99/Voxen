import { load } from "cheerio";
import { config } from "./config";
import { errorMessage, logWarning } from "./logger";

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
const MAX_SNIPPET_CHARS = 600;

interface SearchResult {
  title: string;
  url: string;
  body: string;
}

type Provider = "tavily" | "duckduckgo";

export function activeSearchProvider(): Provider {
  if (config.searchProvider === "tavily") return "tavily";
  if (config.searchProvider === "duckduckgo") return "duckduckgo";
  return config.tavilyApiKey.trim() ? "tavily" : "duckduckgo";
}

function truncate(value: string): string {
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed.length > MAX_SNIPPET_CHARS
    ? `${trimmed.slice(0, MAX_SNIPPET_CHARS - 1)}…`
    : trimmed;
}

function dedupe(results: SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  const unique: SearchResult[] = [];
  for (const result of results) {
    if (!result.url || seen.has(result.url)) continue;
    seen.add(result.url);
    unique.push(result);
  }
  return unique;
}

async function tavilySearch(query: string): Promise<SearchResult[]> {
  const response = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      api_key: config.tavilyApiKey,
      query,
      max_results: MAX_RESULTS,
      search_depth: "basic",
      include_answer: false,
    }),
    signal: AbortSignal.timeout(config.searchTimeoutMs),
  });

  if (!response.ok) {
    throw new Error(`tavily HTTP ${response.status}`);
  }

  const data = (await response.json()) as {
    results?: Array<{ title?: string; url?: string; content?: string }>;
  };

  return (data.results ?? [])
    .filter((result): result is { title?: string; url: string; content?: string } =>
      Boolean(result.url),
    )
    .map((result) => ({
      title: result.title?.trim() || result.url,
      url: result.url,
      body: truncate(result.content ?? ""),
    }));
}

function decodeBounce(href: string): string | null {
  const match = href.match(/[?&]uddg=([^&]+)/);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

async function duckDuckGoSearch(query: string): Promise<SearchResult[]> {
  const url = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`;
  const response = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36",
    },
    signal: AbortSignal.timeout(config.searchTimeoutMs),
  });

  if (!response.ok) {
    throw new Error(`duckduckgo HTTP ${response.status}`);
  }

  const $ = load(await response.text());
  const results: SearchResult[] = [];

  $('a[rel="nofollow"]').each((_, element) => {
    const href = $(element).attr("href") ?? "";
    const target = decodeBounce(href);
    if (!target) return;

    const title = $(element).text().trim();
    if (!title) return;

    const body = $(element)
      .closest("tr")
      .next("tr")
      .find("td.result-snippet")
      .text()
      .trim();

    results.push({ title, url: target, body: truncate(body) });
  });

  return results;
}

export async function searchWeb(query: string): Promise<string> {
  if (!query.trim()) {
    return JSON.stringify({ error: "empty query" });
  }

  try {
    const provider = activeSearchProvider();
    let results: SearchResult[];

    try {
      results =
        provider === "tavily"
          ? await tavilySearch(query)
          : await duckDuckGoSearch(query);
    } catch (err) {
      // If the paid provider fails, fall back to the keyless scraper.
      if (provider === "tavily") {
        logWarning("search.tavily_failed", { message: errorMessage(err) });
        results = await duckDuckGoSearch(query);
      } else {
        throw err;
      }
    }

    const unique = dedupe(results).slice(0, MAX_RESULTS);
    if (unique.length === 0) {
      return JSON.stringify({ error: "no results" });
    }
    return JSON.stringify(unique);
  } catch (err) {
    return JSON.stringify({ error: `search failed: ${errorMessage(err)}` });
  }
}

export function runTool(name: string, argumentsJson: string): Promise<string> {
  if (name === "search_web") {
    let query = "";
    try {
      const args = JSON.parse(argumentsJson || "{}") as { query?: unknown };
      query = typeof args.query === "string" ? args.query : "";
    } catch {
      query = "";
    }
    return searchWeb(query);
  }
  return Promise.resolve(JSON.stringify({ error: `unknown tool: ${name}` }));
}
