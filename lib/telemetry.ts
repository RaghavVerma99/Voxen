import { performance } from "node:perf_hooks";

export const MILESTONES = [
  "transcript",
  "first_delta",
  "done",
  "first_audio",
  "complete",
] as const;

export const STAGES = ["stt", "llm", "tts"] as const;

export type Milestone = (typeof MILESTONES)[number];
export type Stage = (typeof STAGES)[number];

export interface TurnSnapshot {
  requestId: string;
  sessionHash?: string;
  status: "ok" | "error";
  errorCode?: string;
  totalMs: number;
  milestonesMs: Partial<Record<Milestone, number>>;
  stagesMs: Partial<Record<Stage, number>>;
}

interface TimingStats {
  count: number;
  p50: number;
  p95: number;
  max: number;
}

export interface MetricsSnapshot {
  counters: Record<string, number>;
  timings: Record<string, TimingStats>;
}

const MAX_SAMPLES = 500;
const counters = new Map<string, number>();
const samples = new Map<string, number[]>();

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

function percentile(values: number[], ratio: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * ratio) - 1),
  );
  return round(sorted[index]);
}

export function recordTiming(name: string, durationMs: number): void {
  const values = samples.get(name) ?? [];
  values.push(Math.max(0, durationMs));
  if (values.length > MAX_SAMPLES) values.shift();
  samples.set(name, values);
}

export function incrementCounter(name: string, by = 1): void {
  counters.set(name, (counters.get(name) ?? 0) + by);
}

export function telemetrySnapshot(): MetricsSnapshot {
  const timings: Record<string, TimingStats> = {};
  for (const [name, values] of samples) {
    timings[name] = {
      count: values.length,
      p50: percentile(values, 0.5),
      p95: percentile(values, 0.95),
      max: round(Math.max(...values)),
    };
  }
  return {
    counters: Object.fromEntries([...counters].sort(([a], [b]) => a.localeCompare(b))),
    timings: Object.fromEntries(
      Object.entries(timings).sort(([a], [b]) => a.localeCompare(b)),
    ),
  };
}

export function resetTelemetry(): void {
  counters.clear();
  samples.clear();
}

/** Stable error label for trace counters, without importing the HTTP layer. */
export function errorCodeOf(err: unknown): string {
  if (
    err instanceof Error &&
    "code" in err &&
    typeof (err as { code?: unknown }).code === "string"
  ) {
    return (err as { code: string }).code;
  }
  return "INTERNAL";
}

export interface TurnTelemetry {
  milestone(name: Milestone): void;
  stage(name: Stage): () => void;
  finish(errorCode?: string): TurnSnapshot;
  snapshot(): TurnSnapshot;
}

/**
 * One trace per streamed turn. `requestId` correlates the structured logs;
 * the session is pre-hashed because ids are bearer tokens for conversations.
 */
export function startTurnTrace(options: {
  requestId: string;
  sessionHash?: string;
}): TurnTelemetry {
  const startedAt = performance.now();
  const milestonesMs: Partial<Record<Milestone, number>> = {};
  const stagesMs: Partial<Record<Stage, number>> = {};
  let errorCode: string | undefined;
  let finalTotal = 0;
  let finished = false;

  const base = (): Omit<TurnSnapshot, "status" | "totalMs"> => ({
    requestId: options.requestId,
    ...(options.sessionHash ? { sessionHash: options.sessionHash } : {}),
    ...(errorCode ? { errorCode } : {}),
    milestonesMs: { ...milestonesMs },
    stagesMs: { ...stagesMs },
  });

  return {
    milestone(name) {
      if (milestonesMs[name] !== undefined) return;
      milestonesMs[name] = round(performance.now() - startedAt);
    },
    stage(name) {
      const start = performance.now();
      let ended = false;
      return () => {
        if (ended) return;
        ended = true;
        const duration = performance.now() - start;
        stagesMs[name] = round((stagesMs[name] ?? 0) + duration);
        recordTiming(`stage.${name}`, duration);
      };
    },
    finish(code) {
      if (finished) return this.snapshot();
      finished = true;
      errorCode = code;
      finalTotal = performance.now() - startedAt;
      recordTiming("turn.total", finalTotal);
      incrementCounter(code ? `turn.error.${code}` : "turn.ok");
      return this.snapshot();
    },
    snapshot() {
      return {
        ...base(),
        status: errorCode ? "error" : "ok",
        totalMs: round(finished ? finalTotal : performance.now() - startedAt),
      };
    },
  };
}
