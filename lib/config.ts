function toNumber(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export type SearchProvider = "auto" | "tavily" | "duckduckgo";

export type TtsProvider = "speech" | "realtime";
export type TtsFallbackProvider = TtsProvider | "none";

function toSearchProvider(value: string | undefined): SearchProvider {
  const normalized = (value ?? "").trim().toLowerCase();
  if (normalized === "tavily" || normalized === "duckduckgo") return normalized;
  return "auto";
}

function toTtsProvider(value: string | undefined, fallback: TtsProvider): TtsProvider {
  const normalized = (value ?? "").trim().toLowerCase();
  return normalized === "speech" || normalized === "realtime"
    ? normalized
    : fallback;
}

function toTtsFallbackProvider(value: string | undefined): TtsFallbackProvider {
  const normalized = (value ?? "").trim().toLowerCase();
  if (normalized === "none" || normalized === "off") return "none";
  return toTtsProvider(value, "speech");
}

export type ReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

const REASONING_EFFORTS = new Set<string>([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

/**
 * Reasoning is optional per model. An empty value, `default`, or `off` omits
 * the parameter entirely so older Chat Completions models keep working.
 */
function toReasoningEffort(
  value: string | undefined,
): ReasoningEffort | null {
  const normalized = (value ?? "").trim().toLowerCase();
  if (normalized === "" || normalized === "default" || normalized === "off") {
    return null;
  }
  return REASONING_EFFORTS.has(normalized)
    ? (normalized as ReasoningEffort)
    : "none";
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
const accessCode = (process.env.ACCESS_CODE ?? "").trim();

export const config = {
  appName: "Voxen",
  appVersion: process.env.APP_VERSION ?? "1.1.0",
  nodeEnv,
  isProduction: nodeEnv === "production",

  // AI provider
  openaiApiKey: process.env.OPENAI_API_KEY ?? "",
  sttModel: process.env.STT_MODEL ?? "gpt-transcribe",
  llmModel: process.env.LLM_MODEL ?? "gpt-6-luna",
  // Chat Completions tool calls on gpt-6-luna require reasoning_effort "none".
  llmReasoningEffort: toReasoningEffort(
    process.env.LLM_REASONING_EFFORT ?? "none",
  ),
  // The Speech API is deprecated (gpt-4o-mini-tts shuts down January 6, 2027);
  // narration now runs through the Realtime API. Set TTS_PROVIDER=speech to keep
  // the legacy text-to-speech path during the migration window.
  ttsProvider: toTtsProvider(process.env.TTS_PROVIDER, "realtime"),
  // Ordered failover when the primary narrator fails. Set to "none" to stop
  // after the primary adapter (for example, after the Speech API shutdown).
  ttsFallbackProvider: toTtsFallbackProvider(process.env.TTS_FALLBACK_PROVIDER),
  ttsModel: process.env.TTS_MODEL ?? "gpt-4o-mini-tts",
  ttsVoice: process.env.TTS_VOICE ?? "alloy",
  realtimeTtsModel: process.env.REALTIME_TTS_MODEL ?? "gpt-realtime-2.1-mini",
  realtimeTtsVoice: process.env.REALTIME_TTS_VOICE ?? "marin",
  realtimeTtsInstructions: process.env.REALTIME_TTS_INSTRUCTIONS ?? "Speak clearly and warmly. Keep answers concise and easy to follow.",
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

  // Streaming lifecycle
  turnTimeoutMs: toNumber(process.env.TURN_TIMEOUT_MS, 90_000),
  sseHeartbeatMs: toNumber(process.env.SSE_HEARTBEAT_MS, 15_000),

  // Shared access code. Production refuses paid traffic unless this is a
  // long enough secret, so a misconfigured deploy cannot expose the API.
  accessCode,
  minAccessCodeLength: toNumber(process.env.MIN_ACCESS_CODE_LENGTH, 16),
  requireAccessCodeInProduction:
    process.env.REQUIRE_ACCESS_CODE !== "false",

  // Proxy trust: 0 = ignore forwarded headers (direct deployments)
  trustProxyHops: toNumber(
    process.env.TRUST_PROXY_HOPS,
    defaultProxyHops(),
  ),
};

export const isAiConfigured = (): boolean => config.openaiApiKey.trim().length > 0;

/** True when the configured access code meets the minimum length. */
export const isAccessGateConfigured = (): boolean =>
  config.accessCode.length >= config.minAccessCodeLength;

/**
 * A production deployment without a real access gate is unsafe: every paid
 * endpoint is public. Routes fail closed instead of silently accepting traffic.
 */
export const isProductionAccessMisconfigured = (): boolean =>
  config.isProduction &&
  config.requireAccessCodeInProduction &&
  !isAccessGateConfigured();
