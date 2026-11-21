import OpenAI from "openai";
import { config } from "./config";
import { AppError } from "./errors";

let clientInstance: OpenAI | null = null;

export function ensureAiConfigured(): void {
  if (!config.openaiApiKey.trim()) {
    throw new AppError(
      "CONFIG_ERROR",
      "OPENAI_API_KEY is not configured on the server.",
      500,
    );
  }
}

/**
 * One shared client per process: reusing it preserves HTTP connection pooling,
 * which matters for a latency-sensitive voice loop.
 */
export function openaiClient(): OpenAI {
  ensureAiConfigured();
  if (!clientInstance) {
    clientInstance = new OpenAI({
      apiKey: config.openaiApiKey,
      timeout: config.openaiTimeoutMs,
      maxRetries: config.openaiMaxRetries,
    });
  }
  return clientInstance;
}
