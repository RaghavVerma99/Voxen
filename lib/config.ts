function toNumber(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export type SearchProvider = "auto" | "tavily" | "duckduckgo";

function toSearchProvider(value: string | undefined): SearchProvider {
  const normalized = (value ?? "").trim().toLowerCase();
  if (normalized === "tavily" || normalized === "duckduckgo") return normalized;
  return "auto";
}

/**
 * Platforms that always put a trusted proxy in front of the app. Elsewhere
 * we ignore X-Forwarded-For unless the deployer explicitly opts in, because a
 * directly exposed process cannot distinguish a real header from a forged one.
 */
function defaultProxyHops(): number {
  if (process.env.VERCEL || process.env.RENDER || process.env.FLY_APP_NAME) {
    return 1;
  }
  return 0;
}

const nodeEnv = process.env.NODE_ENV ?? "development";

export const config = {
  appName: "Voxen",
  appVersion: process.env.APP_VERSION ?? "1.1.0",
  nodeEnv,
  isProduction: nodeEnv === "production",

  // AI provider
  openaiApiKey: process.env.OPENAI_API_KEY ?? "",
  sttModel: process.env.STT_MODEL ?? "gpt-4o-mini-transcribe",
  llmModel: process.env.LLM_MODEL ?? "gpt-4o-mini",
  ttsModel: process.env.TTS_MODEL ?? "gpt-4o-mini-tts",
  ttsVoice: process.env.TTS_VOICE ?? "alloy",
  maxToolRounds: toNumber(process.env.MAX_TOOL_ROUNDS, 4),
  maxReplyTokens: toNumber(process.env.MAX_REPLY_TOKENS, 600),
  openaiTimeoutMs: toNumber(process.env.OPENAI_TIMEOUT_MS, 30_000),
  openaiMaxRetries: toNumber(process.env.OPENAI_MAX_RETRIES, 2),

  // Search
  searchProvider: toSearchProvider(process.env.SEARCH_PROVIDER),
  tavilyApiKey: process.env.TAVILY_API_KEY ?? "",
  searchTimeoutMs: toNumber(process.env.SEARCH_TIMEOUT_MS, 8_000),

  // Conversation state
  maxHistoryMessages: toNumber(process.env.MAX_HISTORY_MESSAGES, 20),
  sessionTtlMs: toNumber(process.env.SESSION_TTL_MS, 30 * 60 * 1000),
  maxSessions: toNumber(process.env.MAX_SESSIONS, 1_000),

  // Limits & cost controls
  maxAudioBytes: toNumber(process.env.MAX_AUDIO_BYTES, 4 * 1024 * 1024),
  maxAudioSeconds: toNumber(process.env.MAX_AUDIO_SECONDS, 60),
  maxMessageChars: toNumber(process.env.MAX_MESSAGE_CHARS, 4_000),
  maxChatRequestBytes: toNumber(
    process.env.MAX_CHAT_REQUEST_BYTES,
    64 * 1024,
  ),
  maxVoiceRequestBytes: toNumber(
    process.env.MAX_VOICE_REQUEST_BYTES,
    4.5 * 1024 * 1024,
  ),
  rateLimitRequests: toNumber(process.env.RATE_LIMIT_REQUESTS, 20),
  rateLimitWindowMs: toNumber(process.env.RATE_LIMIT_WINDOW_MS, 60_000),
  dailyRequestBudget: toNumber(process.env.DAILY_REQUEST_BUDGET, 1_000),

  // Optional shared access code for private previews
  accessCode: process.env.ACCESS_CODE ?? "",

  // Proxy trust: 0 = ignore forwarded headers (direct deployments)
  trustProxyHops: toNumber(
    process.env.TRUST_PROXY_HOPS,
    defaultProxyHops(),
  ),
};

export const isAiConfigured = (): boolean => config.openaiApiKey.trim().length > 0;
