interface LockState {
  /** Resolves when the most recently queued task has released the lock. */
  tail: Promise<void>;
  pending: number;
}

const locks = new Map<string, LockState>();

/**
 * Serializes work per session. Two tabs (or a retried request) sharing one
 * session id must not interleave history reads and commits, otherwise turns
 * can be duplicated, reordered, or built from a stale snapshot.
 *
 * Different sessions run concurrently; the lock is scoped to the session id.
 */
export async function withSessionLock<T>(
  sessionId: string,
  task: () => Promise<T>,
): Promise<T> {
  const state = locks.get(sessionId) ?? {
    tail: Promise.resolve(),
    pending: 0,
  };
  state.pending += 1;
  locks.set(sessionId, state);

  const previous = state.tail;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  state.tail = previous.then(() => gate);

  await previous;
  try {
    return await task();
  } finally {
    release();
    state.pending -= 1;
    if (state.pending === 0 && locks.get(sessionId) === state) {
      locks.delete(sessionId);
    }
  }
}
