export type StateBackendName = "memory" | "file" | "redis";

export interface StoredMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface StoredSession {
  messages: StoredMessage[];
  createdAt: number;
  lastAccessAt: number;
}

export interface StoredRateBucket {
  count: number;
  resetAt: number;
}

export interface StoredBudget {
  date: string;
  used: number;
}

export interface StoredRealtimeUsage {
  sessions: number;
  audioSeconds: number;
  outputTokens: number;
  updatedAt: string;
}

export type AccountPlan = "free" | "pro" | "enterprise";
export type AccountRole = "user" | "admin";
export type AccountStatus = "active" | "disabled";

export interface StoredAccount {
  id: string;
  name: string;
  email: string;
  keyHash: string;
  plan: AccountPlan;
  role: AccountRole;
  status: AccountStatus;
  createdAt: string;
}

export interface StoredUsage {
  accountId: string;
  date: string;
  requests: number;
  audioSeconds: number;
  outputTokens: number;
  costMicros: number;
  updatedAt: string;
}

/**
 * The full shared-state document. Everything that must hold across instances
 * lives here; workflow bookings keep their own durable file because they have
 * a separate consistency model and audit trail.
 */
export interface StateDocument {
  rate: Record<string, StoredRateBucket>;
  rateOperations: number;
  budget: StoredBudget;
  sessions: Record<string, StoredSession>;
  sessionAccessCount: number;
  realtime: Record<string, StoredRealtimeUsage>;
  accounts: Record<string, StoredAccount>;
  usage: Record<string, StoredUsage>;
  counters: Record<string, number>;
  samples: Record<string, number[]>;
}

export type StateSection = keyof StateDocument;

export interface StateBackend {
  readonly name: StateBackendName;
  /** Reads an isolated snapshot or projection without taking a write lock. */
  read<T>(select: (document: Readonly<StateDocument>) => T): Promise<T>;
  /** Atomically mutates and persists the document. Must not be reentered. */
  write<T>(mutate: (document: StateDocument) => T): Promise<T>;
  /** Clears one section, or the whole document when no section is given. */
  reset(section?: StateSection): Promise<void>;
}

function dictionary<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

/** Creates a normalized, empty document with null-prototype maps. */
export function emptyState(): StateDocument {
  return {
    rate: dictionary<StoredRateBucket>(),
    rateOperations: 0,
    budget: { date: "", used: 0 },
    sessions: dictionary<StoredSession>(),
    sessionAccessCount: 0,
    realtime: dictionary<StoredRealtimeUsage>(),
    accounts: dictionary<StoredAccount>(),
    usage: dictionary<StoredUsage>(),
    counters: dictionary<number>(),
    samples: dictionary<number[]>(),
  };
}

function finite(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * Rebuilds a trusted document from untrusted JSON. Corrupt files throw so a
 * broken shared store fails closed instead of silently dropping hard caps.
 */
export function normalizeState(raw: unknown): StateDocument {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("Shared state file must contain a JSON object.");
  }
  const source = raw as Record<string, unknown>;
  const state = emptyState();

  const rate = source.rate;
  if (typeof rate === "object" && rate !== null && !Array.isArray(rate)) {
    for (const [key, value] of Object.entries(rate)) {
      const bucket = value as Record<string, unknown> | null;
      if (bucket && typeof bucket === "object") {
        state.rate[key] = {
          count: Math.max(0, finite(bucket.count)),
          resetAt: finite(bucket.resetAt),
        };
      }
    }
  }
  state.rateOperations = Math.max(0, Math.floor(finite(source.rateOperations)));

  const budget = source.budget as Record<string, unknown> | undefined;
  state.budget = {
    date: typeof budget?.date === "string" ? budget.date : "",
    used: Math.max(0, finite(budget?.used)),
  };

  const sessions = source.sessions;
  if (typeof sessions === "object" && sessions !== null && !Array.isArray(sessions)) {
    for (const [key, value] of Object.entries(sessions)) {
      const record = value as Record<string, unknown> | null;
      if (!record || typeof record !== "object" || !Array.isArray(record.messages)) {
        continue;
      }
      const messages: StoredMessage[] = [];
      for (const item of record.messages) {
        const message = item as Record<string, unknown> | null;
        if (
          message &&
          typeof message === "object" &&
          (message.role === "system" ||
            message.role === "user" ||
            message.role === "assistant") &&
          typeof message.content === "string"
        ) {
          messages.push({ role: message.role, content: message.content });
        }
      }
      state.sessions[key] = {
        messages,
        createdAt: finite(record.createdAt),
        lastAccessAt: finite(record.lastAccessAt),
      };
    }
  }
  state.sessionAccessCount = Math.max(
    0,
    Math.floor(finite(source.sessionAccessCount)),
  );

  const realtime = source.realtime;
  if (typeof realtime === "object" && realtime !== null && !Array.isArray(realtime)) {
    for (const [key, value] of Object.entries(realtime)) {
      const record = value as Record<string, unknown> | null;
      if (!record || typeof record !== "object") continue;
      state.realtime[key] = {
        sessions: Math.max(0, finite(record.sessions)),
        audioSeconds: Math.max(0, finite(record.audioSeconds)),
        outputTokens: Math.max(0, finite(record.outputTokens)),
        updatedAt:
          typeof record.updatedAt === "string"
            ? record.updatedAt
            : new Date(0).toISOString(),
      };
    }
  }

  const accounts = source.accounts;
  if (typeof accounts === "object" && accounts !== null && !Array.isArray(accounts)) {
    for (const [key, value] of Object.entries(accounts)) {
      const record = value as Record<string, unknown> | null;
      if (!record || typeof record !== "object") continue;
      const plan = record.plan;
      const role = record.role;
      const status = record.status;
      if (
        typeof record.id !== "string" ||
        typeof record.name !== "string" ||
        typeof record.keyHash !== "string" ||
        (plan !== "free" && plan !== "pro" && plan !== "enterprise") ||
        (role !== "user" && role !== "admin") ||
        (status !== "active" && status !== "disabled")
      ) {
        continue;
      }
      state.accounts[key] = {
        id: record.id,
        name: record.name,
        email: typeof record.email === "string" ? record.email : "",
        keyHash: record.keyHash,
        plan,
        role,
        status,
        createdAt:
          typeof record.createdAt === "string"
            ? record.createdAt
            : new Date(0).toISOString(),
      };
    }
  }

  const usage = source.usage;
  if (typeof usage === "object" && usage !== null && !Array.isArray(usage)) {
    for (const [key, value] of Object.entries(usage)) {
      const record = value as Record<string, unknown> | null;
      if (!record || typeof record !== "object") continue;
      if (typeof record.accountId !== "string" || typeof record.date !== "string") {
        continue;
      }
      state.usage[key] = {
        accountId: record.accountId,
        date: record.date,
        requests: Math.max(0, Math.floor(finite(record.requests))),
        audioSeconds: Math.max(0, finite(record.audioSeconds)),
        outputTokens: Math.max(0, Math.floor(finite(record.outputTokens))),
        costMicros: Math.max(0, Math.floor(finite(record.costMicros))),
        updatedAt:
          typeof record.updatedAt === "string"
            ? record.updatedAt
            : new Date(0).toISOString(),
      };
    }
  }

  const counters = source.counters;
  if (typeof counters === "object" && counters !== null && !Array.isArray(counters)) {
    for (const [key, value] of Object.entries(counters)) {
      state.counters[key] = Math.max(0, finite(value));
    }
  }

  const samples = source.samples;
  if (typeof samples === "object" && samples !== null && !Array.isArray(samples)) {
    for (const [key, value] of Object.entries(samples)) {
      if (!Array.isArray(value)) continue;
      state.samples[key] = value.filter(
        (item): item is number => typeof item === "number" && Number.isFinite(item),
      );
    }
  }

  return state;
}
