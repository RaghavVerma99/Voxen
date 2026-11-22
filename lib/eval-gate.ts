import type { EvalDimension, EvalReport } from "./evals";

export type EvalMetric = "passAt1" | "passAt5";

export interface EvalThreshold {
  minPassAt1?: number;
  minPassAt5?: number;
}

export interface EvalThresholds extends EvalThreshold {
  /** Dimension-specific floors override the overall floor when present. */
  byDimension?: Partial<Record<EvalDimension, EvalThreshold>>;
}

export interface EvalBaseline {
  passAt1: number;
  passAt5: number;
  byDimension: Record<EvalDimension, { passAt1: number; passAt5: number }>;
}

export interface EvalGateOptions {
  /** Allowed drop from the committed baseline. Defaults to zero. */
  maxRegression?: number;
  baseline?: EvalBaseline;
}

export interface EvalGateViolation {
  scope: string;
  metric: EvalMetric;
  kind: "threshold" | "regression";
  actual: number;
  expected: number;
}

const EPSILON = 1e-9;

function validScore(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
  );
}

function checkFloor(
  violations: EvalGateViolation[],
  scope: string,
  metric: EvalMetric,
  actual: number,
  minimum: number | undefined,
): void {
  if (!validScore(minimum) || !validScore(actual)) return;
  if (actual + EPSILON < minimum) {
    violations.push({ scope, metric, kind: "threshold", actual, expected: minimum });
  }
}

function checkRegression(
  violations: EvalGateViolation[],
  scope: string,
  metric: EvalMetric,
  actual: number,
  baseline: number | undefined,
  allowed: number,
): void {
  if (!validScore(baseline) || !validScore(actual)) return;
  const expected = baseline - allowed;
  if (actual + EPSILON < expected) {
    violations.push({
      scope,
      metric,
      kind: "regression",
      actual,
      expected: Math.max(0, expected),
    });
  }
}

/**
 * Deterministic CI gate. Thresholds are explicit floors; the optional baseline
 * catches regressions even when a score remains above the floor.
 */
export function checkEvalGates(
  report: EvalReport,
  thresholds: EvalThresholds,
  options: EvalGateOptions = {},
): EvalGateViolation[] {
  const violations: EvalGateViolation[] = [];
  const allowed = validScore(options.maxRegression)
    ? options.maxRegression
    : 0;

  checkFloor(violations, "overall", "passAt1", report.passAt1, thresholds.minPassAt1);
  checkFloor(violations, "overall", "passAt5", report.passAt5, thresholds.minPassAt5);

  for (const dimension of Object.keys(report.byDimension) as EvalDimension[]) {
    const scores = report.byDimension[dimension];
    const dimensionThresholds = thresholds.byDimension?.[dimension];
    checkFloor(
      violations,
      dimension,
      "passAt1",
      scores.passAt1,
      dimensionThresholds?.minPassAt1 ?? thresholds.minPassAt1,
    );
    checkFloor(
      violations,
      dimension,
      "passAt5",
      scores.passAt5,
      dimensionThresholds?.minPassAt5 ?? thresholds.minPassAt5,
    );
  }

  if (options.baseline) {
    checkRegression(
      violations,
      "overall",
      "passAt1",
      report.passAt1,
      options.baseline.passAt1,
      allowed,
    );
    checkRegression(
      violations,
      "overall",
      "passAt5",
      report.passAt5,
      options.baseline.passAt5,
      allowed,
    );
    for (const dimension of Object.keys(report.byDimension) as EvalDimension[]) {
      const scores = report.byDimension[dimension];
      const baselineScores = options.baseline.byDimension[dimension];
      checkRegression(
        violations,
        dimension,
        "passAt1",
        scores.passAt1,
        baselineScores?.passAt1,
        allowed,
      );
      checkRegression(
        violations,
        dimension,
        "passAt5",
        scores.passAt5,
        baselineScores?.passAt5,
        allowed,
      );
    }
  }

  return violations;
}

export function baselineFromReport(report: EvalReport): EvalBaseline {
  return {
    passAt1: report.passAt1,
    passAt5: report.passAt5,
    byDimension: report.byDimension,
  };
}

export function formatGateViolations(
  violations: EvalGateViolation[],
): string[] {
  const percent = (value: number) => `${Math.round(value * 100)}%`;
  return violations.map(
    (violation) =>
      `- ${violation.scope} ${violation.metric}: ${percent(
        violation.actual,
      )} is below ${violation.kind} ${percent(violation.expected)}`,
  );
}
