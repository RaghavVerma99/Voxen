import { config } from "../config";
import type { StateBackend } from "./contract";
import { createFileStateBackend } from "./file";
import { createMemoryStateBackend } from "./memory";

export type {
  StateBackend,
  StateBackendName,
  StateDocument,
  StateSection,
  StoredBudget,
  StoredMessage,
  StoredRateBucket,
  StoredRealtimeUsage,
  StoredSession,
} from "./contract";
export { createFileStateBackend } from "./file";
export { createMemoryStateBackend } from "./memory";

let current: StateBackend | null = null;

function create(): StateBackend {
  return config.stateBackend === "file"
    ? createFileStateBackend()
    : createMemoryStateBackend();
}

/** Returns the process-wide backend, creating it lazily after config is set. */
export function stateBackend(): StateBackend {
  current ??= create();
  return current;
}

/** Forces backend re-selection, mainly for tests that override config. */
export function resetStateBackend(): void {
  current = null;
}

/** Installs an explicit backend for contract tests. */
export function useStateBackendForTests(backend: StateBackend): void {
  current = backend;
}
