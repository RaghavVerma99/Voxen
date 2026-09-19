function toNumber(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  return Number.isNaN(parsed) ? fallback : parsed;
}

export const config = {
  openaiApiKey: process.env.OPENAI_API_KEY ?? "",
  sttModel: process.env.STT_MODEL ?? "gpt-4o-mini-transcribe",
  llmModel: process.env.LLM_MODEL ?? "gpt-4o-mini",
  ttsModel: process.env.TTS_MODEL ?? "gpt-4o-mini-tts",
  ttsVoice: process.env.TTS_VOICE ?? "alloy",
  maxToolRounds: toNumber(process.env.MAX_TOOL_ROUNDS, 4),
  maxHistoryMessages: toNumber(process.env.MAX_HISTORY_MESSAGES, 20),
  maxAudioBytes: toNumber(process.env.MAX_AUDIO_BYTES, 10 * 1024 * 1024),
  maxAudioSeconds: toNumber(process.env.MAX_AUDIO_SECONDS, 60),
  searchTimeoutMs: 8000,
};