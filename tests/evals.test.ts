import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  evaluateDataset,
  scoreAttempt,
  type EvalAttempt,
  type EvalCase,
} from "@/lib/evals";

const timingCase: EvalCase = {
  id: "timing",
  dimension: "timing",
  prompt: "Say something",
  maxLatencyMs: 700,
};

const attempt = (id: string, latencyMs: number): EvalAttempt => ({
  id,
  latencyMs,
  toolCalls: [],
  answer: "Hello",
});

describe("offline eval scoring", () => {
  it("scores timing against the latency budget", () => {
    expect(scoreAttempt(timingCase, attempt("fast", 650)).passed).toBe(true);
    expect(scoreAttempt(timingCase, attempt("slow", 900))).toMatchObject({
      passed: false,
      reasons: ["latency 900ms exceeds 700ms"],
    });
  });

  it("requires a recorded failure and recovery for recovery cases", () => {
    const recovery: EvalCase = {
      id: "recovery",
      dimension: "recovery",
      prompt: "Recover",
    };
    const base = { ...attempt("r", 100), answer: "Sorry, back again." };

    expect(
      scoreAttempt(recovery, {
        ...base,
        events: ["provider_error", "fallback"],
      }).passed,
    ).toBe(true);
    expect(scoreAttempt(recovery, base).reasons).toContain(
      "no failure followed by a successful recovery was recorded",
    );
  });

  it("requires tool use and grounded phrases while rejecting unsupported claims", () => {
    const grounded: EvalCase = {
      id: "grounded",
      dimension: "grounded",
      prompt: "What happened?",
      requiredTool: "search_web",
      requiredPhrases: ["according to the report"],
      forbiddenPhrases: ["always"],
    };

    expect(
      scoreAttempt(grounded, {
        ...attempt("g", 100),
        toolCalls: ["search_web"],
        answer: "According to the report, revenue grew.",
      }).passed,
    ).toBe(true);
    expect(
      scoreAttempt(grounded, {
        ...attempt("bad", 100),
        answer: "Revenue always grew.",
      }).reasons,
    ).toEqual(
      expect.arrayContaining([
        "missing required tool search_web",
        'answer is missing "according to the report"',
        'answer contains unsupported phrase "always"',
      ]),
    );
  });

  it("separates pass@1 from pass@5", () => {
    const report = evaluateDataset([
      {
        testCase: timingCase,
        attempts: [
          attempt("a", 1_000),
          attempt("b", 1_000),
          attempt("c", 1_000),
          attempt("d", 1_000),
          attempt("e", 650),
        ],
      },
    ]);

    expect(report.passAt1).toBeCloseTo(0.2);
    expect(report.passAt5).toBe(1);
  });

  it("scores the checked-in dataset across all three dimensions", () => {
    const dataset = JSON.parse(
      readFileSync(new URL("../evals/dataset.json", import.meta.url), "utf8"),
    ) as Array<{ testCase: EvalCase; attempts: EvalAttempt[] }>;
    const report = evaluateDataset(dataset);

    expect(report.cases).toHaveLength(4);
    expect(Object.keys(report.byDimension).sort()).toEqual([
      "grounded",
      "recovery",
      "timing",
    ]);
    expect(report.passAt1).toBeGreaterThan(0);
    expect(report.passAt5).toBe(1);
  });
});
