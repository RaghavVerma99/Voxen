import { describe, expect, it } from "vitest";

import {
  baselineFromReport,
  checkEvalGates,
  formatGateViolations,
} from "@/lib/eval-gate";
import type { EvalReport } from "@/lib/evals";

function report(passAt1: number, groundedPassAt1 = passAt1): EvalReport {
  return {
    cases: [],
    passAt1,
    passAt5: 1,
    byDimension: {
      timing: { passAt1, passAt5: 1 },
      recovery: { passAt1, passAt5: 1 },
      grounded: { passAt1: groundedPassAt1, passAt5: 1 },
    },
  };
}

describe("eval regression gates", () => {
  it("passes when every score is above its floor", () => {
    const violations = checkEvalGates(report(0.6), {
      minPassAt1: 0.5,
      minPassAt5: 1,
    });
    expect(violations).toEqual([]);
  });

  it("reports overall and dimension-specific threshold failures", () => {
    const violations = checkEvalGates(report(0.6, 0.4), {
      minPassAt1: 0.55,
      minPassAt5: 1,
      byDimension: { grounded: { minPassAt1: 0.5 } },
    });

    expect(violations).toEqual([
      {
        scope: "grounded",
        metric: "passAt1",
        kind: "threshold",
        actual: 0.4,
        expected: 0.5,
      },
    ]);
  });

  it("fails on any drop from the committed baseline", () => {
    const current = report(0.5);
    const violations = checkEvalGates(current, { minPassAt1: 0.4 }, {
      baseline: baselineFromReport(report(0.6)),
    });

    expect(violations.map((violation) => violation.scope)).toEqual([
      "overall",
      "timing",
      "recovery",
      "grounded",
    ]);
    expect(violations[0]).toMatchObject({
      metric: "passAt1",
      kind: "regression",
      actual: 0.5,
      expected: 0.6,
    });
  });

  it("allows an explicitly configured regression budget", () => {
    const violations = checkEvalGates(report(0.55), { minPassAt1: 0.5 }, {
      baseline: baselineFromReport(report(0.6)),
      maxRegression: 0.05,
    });

    expect(violations).toEqual([]);
  });

  it("formats violations for CI output", () => {
    const lines = formatGateViolations([
      {
        scope: "grounded",
        metric: "passAt1",
        kind: "threshold",
        actual: 0.4,
        expected: 0.5,
      },
    ]);
    expect(lines).toEqual([
      "- grounded passAt1: 40% is below threshold 50%",
    ]);
  });
});
