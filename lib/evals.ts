export type EvalDimension = "timing" | "recovery" | "grounded";

export interface EvalCase {
  id: string;
  dimension: EvalDimension;
  prompt: string;
  /** Upper bound for a spoken reply, in milliseconds. */
  maxLatencyMs?: number;
  /** Tool that must have been called before answering. */
  requiredTool?: string;
  requiredPhrases?: string[];
  forbiddenPhrases?: string[];
}

export interface EvalAttempt {
  id: string;
  latencyMs: number;
  toolCalls: string[];
  answer: string;
  /** Ordered lifecycle markers, e.g. `provider_error` then `fallback`. */
  events?: string[];
}

export interface AttemptScore {
  id: string;
  passed: boolean;
  reasons: string[];
}

export interface CaseScore {
  caseId: string;
  dimension: EvalDimension;
  attempts: AttemptScore[];
  passAt1: number;
  passAt5: number;
}

export interface EvalReport {
  cases: CaseScore[];
  passAt1: number;
  passAt5: number;
  byDimension: Record<EvalDimension, { passAt1: number; passAt5: number }>;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function includesPhrase(haystack: string, phrase: string): boolean {
  return haystack.toLowerCase().includes(phrase.toLowerCase());
}

/**
 * Scores one recorded attempt against its case. Every rule is deterministic so
 * CI can compare runs without a model or network connection.
 */
export function scoreAttempt(testCase: EvalCase, attempt: EvalAttempt): AttemptScore {
  const reasons: string[] = [];
  const answer = attempt.answer ?? "";
  const events = attempt.events ?? [];

  if (
    testCase.maxLatencyMs !== undefined &&
    attempt.latencyMs > testCase.maxLatencyMs
  ) {
    reasons.push(
      `latency ${attempt.latencyMs}ms exceeds ${testCase.maxLatencyMs}ms`,
    );
  }

  if (
    testCase.requiredTool &&
    !attempt.toolCalls.includes(testCase.requiredTool)
  ) {
    reasons.push(`missing required tool ${testCase.requiredTool}`);
  }

  for (const phrase of testCase.requiredPhrases ?? []) {
    if (!includesPhrase(answer, phrase)) {
      reasons.push(`answer is missing "${phrase}"`);
    }
  }

  for (const phrase of testCase.forbiddenPhrases ?? []) {
    if (includesPhrase(answer, phrase)) {
      reasons.push(`answer contains unsupported phrase "${phrase}"`);
    }
  }

  if (testCase.dimension === "recovery") {
    const failed = events.includes("provider_error") || events.includes("interruption");
    const recovered =
      events.includes("fallback") ||
      events.includes("retry") ||
      events.includes("resumed");
    if (!failed || !recovered) {
      reasons.push("no failure followed by a successful recovery was recorded");
    }
  }

  if (testCase.dimension === "grounded" && !answer.trim()) {
    reasons.push("grounded answers must not be empty");
  }

  return { id: attempt.id, passed: reasons.length === 0, reasons };
}

export function scoreCase(testCase: EvalCase, attempts: EvalAttempt[]): CaseScore {
  const scores = attempts.map((attempt) => scoreAttempt(testCase, attempt));
  const passAt1 = mean(scores.map((score) => (score.passed ? 1 : 0)));
  const passAt5 = scores.slice(0, 5).some((score) => score.passed) ? 1 : 0;
  return {
    caseId: testCase.id,
    dimension: testCase.dimension,
    attempts: scores,
    passAt1,
    passAt5,
  };
}

/** Evaluates a dataset of cases with recorded attempts and aggregates scores. */
export function evaluateDataset(
  dataset: Array<{ testCase: EvalCase; attempts: EvalAttempt[] }>,
): EvalReport {
  const cases = dataset.map(({ testCase, attempts }) =>
    scoreCase(testCase, attempts),
  );
  const byDimension = {
    timing: { passAt1: 0, passAt5: 0 },
    recovery: { passAt1: 0, passAt5: 0 },
    grounded: { passAt1: 0, passAt5: 0 },
  } satisfies EvalReport["byDimension"];

  for (const dimension of Object.keys(byDimension) as EvalDimension[]) {
    const matching = cases.filter((entry) => entry.dimension === dimension);
    byDimension[dimension] = {
      passAt1: mean(matching.map((entry) => entry.passAt1)),
      passAt5: mean(matching.map((entry) => entry.passAt5)),
    };
  }

  return {
    cases,
    passAt1: mean(cases.map((entry) => entry.passAt1)),
    passAt5: mean(cases.map((entry) => entry.passAt5)),
    byDimension,
  };
}
