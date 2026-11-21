import { readFileSync } from "node:fs";

import { evaluateDataset, type EvalAttempt, type EvalCase } from "../lib/evals.ts";

interface DatasetEntry {
  testCase: EvalCase;
  attempts: EvalAttempt[];
}

const path = process.argv[2] ?? new URL("../evals/dataset.json", import.meta.url);
const dataset = JSON.parse(readFileSync(path, "utf8")) as DatasetEntry[];

if (!Array.isArray(dataset)) {
  throw new Error("Eval dataset must be an array of cases.");
}

const report = evaluateDataset(dataset);
const percent = (value: number) => `${Math.round(value * 100)}%`;

console.log(`Voxen offline evals (${report.cases.length} cases)`);
for (const entry of report.cases) {
  const failures = entry.attempts.filter((attempt) => !attempt.passed);
  console.log(
    `- ${entry.caseId} [${entry.dimension}] pass@1=${percent(entry.passAt1)} pass@5=${percent(entry.passAt5)}${
      failures.length ? ` failures=${failures.map((item) => item.id).join(",")}` : ""
    }`,
  );
}
console.log(
  `Overall pass@1=${percent(report.passAt1)} pass@5=${percent(report.passAt5)}`,
);
for (const [dimension, scores] of Object.entries(report.byDimension)) {
  console.log(
    `  ${dimension}: pass@1=${percent(scores.passAt1)} pass@5=${percent(scores.passAt5)}`,
  );
}
