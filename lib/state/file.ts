import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { config } from "../config";
import {
  emptyState,
  normalizeState,
  type StateBackend,
  type StateDocument,
} from "./contract";

const sleepBuffer = new SharedArrayBuffer(4);
const sleepWord = new Int32Array(sleepBuffer);

function pause(ms: number): void {
  Atomics.wait(sleepWord, 0, 0, ms);
}

/**
 * A directory is our cross-process mutex: mkdir is atomic on every supported
 * platform. A stale lock is reclaimable after a crash, and a timeout keeps a
 * hung writer from blocking requests forever.
 */
export function createFileStateBackend(
  filePath = config.stateStorePath,
): StateBackend {
  const lockPath = `${filePath}.lock`;
  let locked = false;

  function acquire(): void {
    if (locked) {
      throw new Error("Reentrant shared-state write detected.");
    }
    const deadline = Date.now() + config.stateLockTimeoutMs;
    while (true) {
      try {
        mkdirSync(lockPath);
        writeFileSync(`${lockPath}/owner`, String(process.pid));
        locked = true;
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST") throw error;

        try {
          const age = Date.now() - statSync(lockPath).mtimeMs;
          if (age > config.stateLockStaleMs) {
            rmSync(lockPath, { recursive: true, force: true });
            continue;
          }
        } catch {
          // The lock vanished between mkdir and stat; retry immediately.
        }

        if (Date.now() >= deadline) {
          throw new Error("Timed out acquiring the shared state lock.");
        }
        pause(5);
      }
    }
  }

  function release(): void {
    if (!locked) return;
    locked = false;
    rmSync(lockPath, { recursive: true, force: true });
  }

  function load(): StateDocument {
    try {
      const raw = readFileSync(filePath, "utf8");
      return normalizeState(JSON.parse(raw) as unknown);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return emptyState();
      }
      throw error;
    }
  }

  function save(document: StateDocument): void {
    mkdirSync(dirname(filePath), { recursive: true });
    const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(document), "utf8");
    renameSync(temporary, filePath);
  }

  async function write<T>(mutate: (document: StateDocument) => T): Promise<T> {
    acquire();
    try {
      const document = load();
      const result = mutate(document);
      save(document);
      return result;
    } finally {
      release();
    }
  }

  return {
    name: "file",
    async read(select) {
      return select(load());
    },
    write,
    async reset(section) {
      await write((document) => {
        const fresh = emptyState();
        if (!section) {
          for (const key of Object.keys(document) as Array<keyof StateDocument>) {
            delete document[key];
          }
          Object.assign(document, fresh);
          return;
        }
        (document as unknown as Record<string, unknown>)[section] = fresh[section];
      });
    },
  };
}
