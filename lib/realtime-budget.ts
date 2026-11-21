import { config } from "./config";
import { AppError } from "./errors";

export interface RealtimeUsage {
  sessions: number;
  audioSeconds: number;
  outputTokens: number;
  updatedAt: string;
}

const MAX_TRACKED_SESSIONS = 1_000;
const usage = new Map<string, RealtimeUsage>();

function fresh(): RealtimeUsage {
  return { sessions: 0, audioSeconds: 0, outputTokens: 0, updatedAt: new Date().toISOString() };
}

function get(sessionId: string): RealtimeUsage {
  let record = usage.get(sessionId);
  if (!record) {
    record = fresh();
    usage.set(sessionId, record);
    if (usage.size > MAX_TRACKED_SESSIONS) {
      const oldest = usage.keys().next().value;
      if (oldest !== undefined && oldest !== sessionId) usage.delete(oldest);
    }
  }
  return record;
}

/** Reserves one WebRTC session before an ephemeral token is minted. */
export function startRealtimeSession(sessionId: string): void {
  const record = get(sessionId);
  if (record.sessions >= config.realtimeMaxSessions) {
    throw new AppError(
      "BUDGET_EXHAUSTED",
      "Realtime session limit reached for this conversation.",
      429,
    );
  }
  record.sessions += 1;
  record.updatedAt = new Date().toISOString();
}

/** Refunds a reservation when upstream token creation fails. */
export function releaseRealtimeSession(sessionId: string): void {
  const record = usage.get(sessionId);
  if (!record || record.sessions === 0) return;
  record.sessions -= 1;
  record.updatedAt = new Date().toISOString();
  if (
    record.sessions === 0 &&
    record.audioSeconds === 0 &&
    record.outputTokens === 0
  ) {
    usage.delete(sessionId);
  }
}

function validNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * Records final usage reported by the browser. The client's numbers are a
 * best-effort accounting signal; hard limits are also enforced by the session
 * configuration on the provider side.
 */
export function recordRealtimeUsage(
  sessionId: string,
  input: { audioSeconds?: unknown; outputTokens?: unknown },
): RealtimeUsage {
  const audioSeconds = input.audioSeconds ?? 0;
  const outputTokens = input.outputTokens ?? 0;
  if (!validNumber(audioSeconds) || !validNumber(outputTokens)) {
    throw new AppError(
      "INVALID_BODY",
      "Usage values must be non-negative numbers.",
      400,
    );
  }

  const record = get(sessionId);
  const nextAudio = record.audioSeconds + audioSeconds;
  const nextTokens = record.outputTokens + outputTokens;
  if (
    nextAudio > config.realtimeMaxAudioSeconds ||
    nextTokens > config.realtimeMaxOutputTokens
  ) {
    throw new AppError(
      "BUDGET_EXHAUSTED",
      "Realtime audio or token budget exceeded for this conversation.",
      429,
    );
  }

  record.audioSeconds = nextAudio;
  record.outputTokens = nextTokens;
  record.updatedAt = new Date().toISOString();
  return { ...record };
}

export function realtimeUsageSnapshot(sessionId: string): RealtimeUsage | null {
  const record = usage.get(sessionId);
  return record ? { ...record } : null;
}

export function resetRealtimeBudget(): void {
  usage.clear();
}
