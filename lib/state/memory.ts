import { emptyState, type StateBackend } from "./contract";

/**
 * Default single-process backend. The document is kept in memory, so all
 * callers in this process see the same caps without any disk I/O.
 */
export function createMemoryStateBackend(): StateBackend {
  let document = emptyState();

  return {
    name: "memory",
    async read(select) {
      return select(document);
    },
    async write(mutate) {
      return mutate(document);
    },
    async reset(section) {
      const fresh = emptyState();
      if (!section) {
        document = fresh;
        return;
      }
      (document as unknown as Record<string, unknown>)[section] = fresh[section];
    },
  };
}
