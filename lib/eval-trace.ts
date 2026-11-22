import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

import { config } from "./config.ts";
import type { EvalAttempt, EvalDimension } from "./evals";
import type { Milestone, Stage, TurnTransport } from "./telemetry";

const LABEL_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;
const MAX_LISTS = 20;

/** Opt-in labels sent by the eval recorder; they never grant access or budget. */
export interface EvalLabels {
  caseId?: string;
  attemptId?: string;
  dimension?: EvalDimension;
}

export interface EvalTraceInput extends EvalLabels {
  requestId: string;
  answer: string;
  toolCalls?: string[];
  events?: string[];
  latencyMs: number;
  sessionHash?: string;
  transport?: TurnTransport;
  promptChars?: number;
  status?: "ok" | "error";
  errorCode?: string;
  milestonesMs?: Partial<Record<Milestone, number>>;
  stagesMs?: Partial<Record<Stage, number>>;
}

export interface EvalTraceRecord extends EvalTraceInput {
  timestamp: string;
  status: "ok" | "error";
  toolCalls: string[];
  events: string[];
}

function cleanLabel(value: unknown): string | undefined {
  return typeof value === "string" && LABEL_PATTERN.test(value.trim())
    ? value.trim()
    : undefined;
}

export function evalLabelsFromHeaders(headers: Headers): EvalLabels {
  const dimension = cleanLabel(headers.get("x-eval-dimension"));
  return {
    caseId: cleanLabel(headers.get("x-eval-case-id")),
    attemptId: cleanLabel(headers.get("x-eval-attempt-id")),
    dimension:
      dimension === "timing" ||
      dimension === "recovery" ||
      dimension === "grounded"
        ? dimension
        : undefined,
  };
}

function cleanText(value: unknown, limit: number): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

function cleanList(values: string[] | undefined, label: boolean): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values ?? []) {
    const cleaned = label ? cleanLabel(value) : cleanText(value, 48);
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    result.push(cleaned);
    if (result.length === MAX_LISTS) break;
  }
  return result;
}

function cleanTimingMap<T extends string>(
  value: Partial<Record<T, number>> | undefined,
): Partial<Record<T, number>> {
  const result: Partial<Record<T, number>> = {};
  if (!value) return result;
  for (const [name, raw] of Object.entries(value)) {
    if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) {
      result[name as T] = Math.round(raw);
    }
  }
  return result;
}

function normalize(input: EvalTraceInput): EvalTraceRecord {
  const latencyMs =
    typeof input.latencyMs === "number" &&
    Number.isFinite(input.latencyMs) &&
    input.latencyMs >= 0
      ? Math.min(Math.round(input.latencyMs), config.turnTimeoutMs)
      : 0;

  return {
    ...input,
    timestamp: new Date().toISOString(),
    requestId: cleanText(input.requestId, 64),
    caseId: cleanLabel(input.caseId),
    attemptId: cleanLabel(input.attemptId),
    dimension: input.dimension,
    sessionHash: cleanLabel(input.sessionHash),
    transport: input.transport,
    promptChars:
      typeof input.promptChars === "number" && Number.isFinite(input.promptChars)
        ? Math.max(0, Math.round(input.promptChars))
        : undefined,
    answer: cleanText(input.answer, config.evalTraceMaxAnswerChars),
    toolCalls: cleanList(input.toolCalls, true),
    events: cleanList(input.events, false),
    latencyMs,
    status: input.status === "error" ? "error" : "ok",
    errorCode: cleanLabel(input.errorCode),
    milestonesMs: cleanTimingMap(input.milestonesMs),
    stagesMs: cleanTimingMap(input.stagesMs),
  };
}

function trimFile(path: string): void {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return;
  }
  const lines = raw.split("\n").filter(Boolean);
  const overRows = lines.length > config.evalTraceMaxRows;
  const overBytes = Buffer.byteLength(raw, "utf8") > config.evalTraceMaxBytes;
  if (!overRows && !overBytes) return;

  const kept = lines.slice(-Math.max(1, config.evalTraceMaxRows));
  let content = `${kept.join("\n")}\n`;
  while (Buffer.byteLength(content, "utf8") > config.evalTraceMaxBytes && kept.length > 1) {
    kept.shift();
    content = `${kept.join("\n")}\n`;
  }

  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, content, "utf8");
  renameSync(temporary, path);
}

/**
 * Appends one sanitized trace when evaluation recording is enabled. The file is
 * local to the instance; use a shared volume if several instances record into
 * the same path.
 */
export function recordEvalTrace(input: EvalTraceInput): void {
  if (!config.evalTraceEnabled) return;
  const record = normalize(input);
  const path = config.evalTracePath;
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
  trimFile(path);
}

/** Reads the JSONL trace file, skipping corrupt or truncated lines. */
export function readEvalTraces(path = config.evalTracePath): EvalTraceRecord[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }

  const records: EvalTraceRecord[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as EvalTraceRecord;
      if (
        typeof value.requestId === "string" &&
        typeof value.answer === "string" &&
        typeof value.latencyMs === "number"
      ) {
        records.push(value);
      }
    } catch {
      // A truncated final line must not invalidate earlier traces.
    }
  }
  return records;
}

/** Converts successful recorded traces into scorable eval attempts. */
export function traceToAttempt(record: EvalTraceRecord): EvalAttempt | null {
  if (record.status === "error" || !record.answer.trim()) return null;
  return {
    id: record.attemptId ?? record.requestId,
    latencyMs: record.latencyMs,
    toolCalls: record.toolCalls ?? [],
    answer: record.answer,
    events: record.events ?? [],
  };
}

/**
 * Builds an eval dataset from labeled live traces. Cases keep their original
 * thresholds; only attempts are replaced with recorded provider behavior.
 */
export function liveTracesToDataset(
  records: EvalTraceRecord[],
  cases: Array<{ testCase: import("./evals").EvalCase }>,
): Array<{ testCase: import("./evals").EvalCase; attempts: EvalAttempt[] }> {
  const attempts = new Map<string, EvalAttempt[]>();
  for (const record of records) {
    if (!record.caseId) continue;
    const attempt = traceToAttempt(record);
    if (!attempt) continue;
    const bucket = attempts.get(record.caseId) ?? [];
    bucket.push(attempt);
    attempts.set(record.caseId, bucket);
  }

  return cases
    .map(({ testCase }) => ({ testCase, attempts: attempts.get(testCase.id) ?? [] }))
    .filter((entry) => entry.attempts.length > 0);
}

export function evalTracesAvailable(path = config.evalTracePath): boolean {
  return existsSync(path);
}
