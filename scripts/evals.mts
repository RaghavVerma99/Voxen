import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  baselineFromReport,
  checkEvalGates,
  formatGateViolations,
  type EvalBaseline,
  type EvalThresholds,
} from "../lib/eval-gate.ts";
import { evaluateDataset, type EvalAttempt, type EvalCase } from "../lib/evals.ts";
import { liveTracesToDataset, readEvalTraces } from "../lib/eval-trace.ts";

interface DatasetEntry {
  testCase: EvalCase;
  attempts: EvalAttempt[];
}

interface CliOptions {
  datasetPath: string;
  casesPath: string;
  thresholdsPath: string;
  baselinePath: string;
  tracesPath: string;
  gate: boolean;
  useBaseline: boolean;
  writeBaselinePath?: string;
}

const root = fileURLToPath(new URL("..", import.meta.url));
const fromRoot = (relative: string) => resolve(root, relative);

function flagValue(
  name: string,
  fallback: string,
  allowMissing = false,
): string {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) {
    if (allowMissing) return fallback;
    throw new Error(`${name} requires a path.`);
  }
  return value;
}

function parseOptions(): CliOptions {
  const args = process.argv.slice(2);
  const valueFlags = new Set([
    "--cases",
    "--thresholds",
    "--baseline",
    "--traces",
    "--write-baseline",
  ]);
  let datasetArg: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (valueFlags.has(arg)) {
      index += 1;
      continue;
    }
    if (!arg.startsWith("--") && !datasetArg) datasetArg = arg;
  }

  const datasetPath = datasetArg
    ? resolve(process.cwd(), datasetArg)
    : fromRoot("evals/dataset.json");

  return {
    datasetPath,
    casesPath: flagValue("--cases", datasetPath),
    thresholdsPath: flagValue("--thresholds", fromRoot("evals/thresholds.json")),
    baselinePath: flagValue("--baseline", fromRoot("evals/baseline.json")),
    tracesPath: flagValue("--traces", ".data/eval-traces.jsonl", true),
    gate: args.includes("--gate"),
    useBaseline: !args.includes("--no-baseline"),
    writeBaselinePath: args.includes("--write-baseline")
      ? flagValue("--write-baseline", fromRoot("evals/baseline.json"))
      : undefined,
  };
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function loadDataset(options: CliOptions): DatasetEntry[] {
  const useTraces = process.argv.includes("--traces");
  if (!useTraces) {
    const dataset = readJson<DatasetEntry[]>(options.datasetPath);
    if (!Array.isArray(dataset)) {
      throw new Error("Eval dataset must be an array of cases.");
    }
    return dataset;
  }

  const cases = readJson<DatasetEntry[]>(options.casesPath);
  if (!Array.isArray(cases)) {
    throw new Error("Eval case file must be an array of cases.");
  }
  const records = readEvalTraces(options.tracesPath);
  const dataset = liveTracesToDataset(records, cases);
  if (dataset.length === 0) {
    throw new Error(
      `No labeled successful traces found in ${options.tracesPath}. Send x-eval-case-id headers while EVAL_TRACE_ENABLED=true.`,
    );
  }
  return dataset;
}

function printReport(report: ReturnType<typeof evaluateDataset>, source: string): void {
  const percent = (value: number) => `${Math.round(value * 100)}%`;
  console.log(`Voxen evals (${report.cases.length} cases, ${source})`);
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
}

function main(): void {
  const options = parseOptions();
  const dataset = loadDataset(options);
  const report = evaluateDataset(dataset);
  const source = process.argv.includes("--traces")
    ? `live traces ${options.tracesPath}`
    : options.datasetPath;
  printReport(report, source);

  if (options.writeBaselinePath) {
    mkdirSync(dirname(options.writeBaselinePath), { recursive: true });
    writeFileSync(
      options.writeBaselinePath,
      `${JSON.stringify(baselineFromReport(report), null, 2)}\n`,
      "utf8",
    );
    console.log(`Baseline written to ${options.writeBaselinePath}`);
  }

  if (!options.gate) return;

  const thresholds = readJson<EvalThresholds>(options.thresholdsPath);
  const baseline = options.useBaseline
    ? readJson<EvalBaseline>(options.baselinePath)
    : undefined;
  const violations = checkEvalGates(report, thresholds, {
    baseline,
  });
  if (violations.length > 0) {
    console.error("Eval gates failed:");
    for (const line of formatGateViolations(violations)) console.error(line);
    process.exitCode = 1;
    return;
  }
  console.log("Eval gates passed.");
}

main();
