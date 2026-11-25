import { randomUUID } from "node:crypto";
import { createClient, type RedisClientType } from "redis";

import { config } from "../config";
import {
  emptyState,
  normalizeState,
  type StateBackend,
  type StateDocument,
  type StateSection,
} from "./contract";

/** Redis options used by this adapter. */
export interface RedisSetOptions {
  nx?: boolean;
  px?: number;
}

/**
 * Minimal Redis surface used by the adapter. Injecting it keeps the locking
 * and normalization contract unit-testable without a running Redis server.
 */
export interface RedisStateClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options?: RedisSetOptions): Promise<string | null>;
  eval(script: string, keys: string[], args: string[]): Promise<unknown>;
}

/** Deletes the lock only when it still belongs to the writer that acquired it. */
export const RELEASE_LOCK_SCRIPT = `if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0`;

/** Extends a lock only while it still belongs to the active writer. */
export const RENEW_LOCK_SCRIPT = `if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("pexpire", KEYS[1], ARGV[2])
end
return 0`;

const LOCK_RETRY_MS = 25;

type RawRedisClient = RedisClientType;

function wrapClient(redis: RawRedisClient): RedisStateClient {
  return {
    get(key) {
      return redis.get(key);
    },
    set(key, value, options) {
      return redis.set(
        key,
        value,
        options?.px
          ? {
              NX: options.nx,
              expiration: { type: "PX", value: options.px },
            }
          : undefined,
      );
    },
    eval(script, keys, args) {
      return redis.eval(script, { keys, arguments: args });
    },
  };
}

export interface RedisStateBackendOptions {
  /** Pre-built client, typically a test double. Not closed by `close()`. */
  client?: RedisStateClient;
  url?: string;
  key?: string;
  lockTtlMs?: number;
  lockTimeoutMs?: number;
}

export interface RedisStateBackend extends StateBackend {
  /** Disconnects a client created by the adapter. */
  close(): Promise<void>;
}

/**
 * Stores the whole shared document as one JSON value. Writes are serialized
 * by a Redis lock with a token-checked release; a crashed worker's lock is
 * reclaimed by its TTL instead of blocking all future writes.
 */
export function createRedisStateBackend(
  options: RedisStateBackendOptions = {},
): RedisStateBackend {
  const url = options.url ?? config.redisUrl;
  const stateKey = options.key ?? config.redisStateKey;
  const lockKey = `${stateKey}:lock`;
  const lockTtlMs = Math.max(1, Math.floor(options.lockTtlMs ?? config.redisLockTtlMs));
  const lockTimeoutMs = Math.max(0, options.lockTimeoutMs ?? config.redisLockTimeoutMs);
  const renewEveryMs = Math.max(1, Math.floor(lockTtlMs / 3));
  if (!stateKey.trim()) throw new Error("REDIS_STATE_KEY must not be empty.");
  const injected = options.client;

  let owned: RawRedisClient | null = null;
  let connection: Promise<RedisStateClient> | null = null;

  async function client(): Promise<RedisStateClient> {
    if (injected) return injected;
    connection ??= (async () => {
      const redis = createClient({ url });
      // node-redis reconnects on its own; command failures still surface to
      // callers. The listener prevents an unhandled 'error' event.
      redis.on("error", () => {});
      try {
        await redis.connect();
      } catch {
        // Never surface the connection URL: it may embed credentials.
        redis.destroy();
        throw new Error("Unable to connect to the Redis state store.");
      }
      owned = redis;
      return wrapClient(redis);
    })();
    try {
      return await connection;
    } catch (error) {
      connection = null;
      throw error;
    }
  }

  function parse(raw: string): StateDocument {
    let value: unknown;
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      throw new Error("Shared Redis state is not valid JSON.");
    }
    return normalizeState(value);
  }

  async function load(store: RedisStateClient): Promise<StateDocument> {
    const raw = await store.get(stateKey);
    return raw === null ? emptyState() : parse(raw);
  }

  async function acquire(store: RedisStateClient): Promise<string> {
    const token = randomUUID();
    const deadline = Date.now() + lockTimeoutMs;
    for (;;) {
      const reply = await store.set(lockKey, token, { nx: true, px: lockTtlMs });
      if (reply === "OK") return token;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error("Timed out acquiring the Redis state lock.");
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(LOCK_RETRY_MS, remaining)));
    }
  }

  async function write<T>(
    mutate: (document: StateDocument) => T | Promise<T>,
  ): Promise<Awaited<T>> {
    const store = await client();
    const token = await acquire(store);
    // Keep the lock alive for slow writes. If renewal fails, the original TTL
    // still reclaims a crashed worker instead of deadlocking the app.
    const renewal = setInterval(() => {
      void store
        .eval(RENEW_LOCK_SCRIPT, [lockKey], [token, String(lockTtlMs)])
        .catch(() => {});
    }, renewEveryMs);
    renewal.unref?.();
    try {
      const document = await load(store);
      const result = await mutate(document);
      await store.set(stateKey, JSON.stringify(document));
      return result;
    } finally {
      clearInterval(renewal);
      // A failure here must not mask the write result; the lock expires by TTL.
      try {
        await store.eval(RELEASE_LOCK_SCRIPT, [lockKey], [token]);
      } catch {
        // Best effort: reclamation is handled by the lock TTL.
      }
    }
  }

  const backend: RedisStateBackend = {
    name: "redis",
    async read(select) {
      return select(await load(await client()));
    },
    write,
    async reset(section?: StateSection) {
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
    async close() {
      const redis = owned;
      owned = null;
      connection = null;
      if (redis) await redis.quit();
    },
  };

  return backend;
}
