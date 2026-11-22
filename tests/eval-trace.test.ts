import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { config } from "@/lib/config";
import {
  evalLabelsFromHeaders,
  evalTracesAvailable,
  liveTracesToDataset,
  readEvalTraces,
  recordEvalTrace,
  traceToAttempt,
} from "@/lib/eval-trace";
import type { EvalTraceRecord } from "@/lib/eval-trace";
import { startTurnTrace } from "@/lib/telemetry";

describe("eval trace recording", () => {
  const original = {
    enabled: config.evalTraceEnabled,
    path: config.evalTracePath,
    maxRows: config.evalTraceMaxRows,
    maxBytes: config.evalTraceMaxBytes,
    maxAnswerChars: config.evalTraceMaxAnswerChars,
  };
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "voxen-eval-"));
    config.evalTraceEnabled = false;
    config.evalTracePath = join(directory, "traces.jsonl");
    config.evalTraceMaxRows = 5;
    config.evalTraceMaxBytes = 100_000;
    config.evalTraceMaxAnswerChars = 40;
  });

  afterEach(() => {
    Object.assign(config, original);
    rmSync(directory, { recursive: true, force: true });
  });

  it("ignores recording when the opt-in flag is off", () => {
    recordEvalTrace({
      requestId: "req-1",
      answer: "secret answer",
      latencyMs: 100,
    });

    expect(evalTracesAvailable()).toBe(false);
  });

  it("sanitizes labels, text, timings, and session identifiers", () => {
    config.evalTraceEnabled = true;
    recordEvalTrace({
      requestId: "req-1",
      answer: "Line one\nLine two   with  spaces and a very long suffix that should be cut off",
      latencyMs: -12,
      caseId: "greeting/basic",
      attemptId: "attempt-1\nEVIL",
      sessionHash: "sha256:abcdef123456",
      toolCalls: ["search_web", "bad tool", "search_web"],
      events: ["provider_error", "line\nbreak"],
      milestonesMs: { done: 12.8, complete: -4 },
    });

    const [record] = readEvalTraces();
    expect(record.caseId).toBeUndefined();
    expect(record.attemptId).toBeUndefined();
    expect(record.sessionHash).toBe("sha256:abcdef123456");
    expect(record.latencyMs).toBe(0);
    expect(record.answer).not.toContain("\n");
    expect(record.answer.length).toBeLessThanOrEqual(40);
    expect(record.toolCalls).toEqual(["search_web"]);
    expect(record.events).toEqual(["provider_error", "line break"]);
    expect(record.milestonesMs).toEqual({ done: 13 });
  });

  it("accepts safe metric labels and converts useful traces into attempts", () => {
    const labels = evalLabelsFromHeaders(
      new Headers({
        "x-eval-case-id": "case.1:greeting",
        "x-eval-attempt-id": "attempt_2",
        "x-eval-dimension": "recovery",
      }),
    );
    expect(labels).toEqual({
      caseId: "case.1:greeting",
      attemptId: "attempt_2",
      dimension: "recovery",
    });

    config.evalTraceEnabled = true;
    recordEvalTrace({
      ...labels,
      requestId: "req-2",
      answer: "I can help with that.",
      latencyMs: 240,
      toolCalls: ["search_web"],
      events: ["provider_error", "resumed"],
    });
    recordEvalTrace({
      ...labels,
      requestId: "req-3",
      answer: "",
      status: "error",
      latencyMs: 50,
    });

    const records = readEvalTraces();
    expect(traceToAttempt(records[1])).toBeNull();
    const attempt = traceToAttempt(records[0]);
    expect(attempt).toMatchObject({
      id: "attempt_2",
      latencyMs: 240,
      toolCalls: ["search_web"],
    });

    const dataset = liveTracesToDataset(records, [
      {
        testCase: {
          id: "case.1:greeting",
          dimension: "recovery",
          prompt: "hello",
        },
      },
      {
        testCase: {
          id: "other",
          dimension: "timing",
          prompt: "other",
        },
      },
    ]);
    expect(dataset).toHaveLength(1);
    expect(dataset[0].attempts).toHaveLength(1);
  });

  it("skips corrupt lines and bounds the stored file", () => {
    config.evalTraceEnabled = true;
    writeFileSync(config.evalTracePath, "not json\n", "utf8");
    for (let index = 0; index < 8; index += 1) {
      recordEvalTrace({
        requestId: `req-${index}`,
        answer: `answer ${index}`,
        latencyMs: index,
      });
    }

    const records = readEvalTraces();
    expect(records).toHaveLength(5);
    expect(records[0].requestId).toBe("req-3");
    expect(records.at(-1)?.requestId).toBe("req-7");
  });

  it("hashes raw session ids when starting a trace", () => {
    const snapshot = startTurnTrace({
      requestId: "req-4",
      sessionId: "session-token",
    }).finish();

    expect(snapshot.sessionHash).toMatch(/^sha256:[a-f0-9]{12}$/);
    expect(snapshot.sessionHash).not.toContain("session-token");
  });
});

describe("record shape", () => {
  it("keeps only scorable fields in an eval attempt", () => {
    const record: EvalTraceRecord = {
      requestId: "req",
      timestamp: new Date().toISOString(),
      answer: "answer",
      latencyMs: 10,
      status: "ok",
      toolCalls: ["tool"],
      events: [],
      sessionHash: "sha256:123456789abc",
    };
    expect(traceToAttempt(record)).toEqual({
      id: "req",
      latencyMs: 10,
      toolCalls: ["tool"],
      answer: "answer",
      events: [],
    });
  });
});
