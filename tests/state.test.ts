import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { config } from "@/lib/config";
import {
  createFileStateBackend,
  createMemoryStateBackend,
  useStateBackendForTests,
  type StateBackend,
} from "@/lib/state";
import { consumeDailyBudget, rateLimit } from "@/lib/ratelimit";
import { addMessage, getHistory } from "@/lib/conversation";
import { startRealtimeSession } from "@/lib/realtime-budget";

const directories: string[] = [];
let contractPath = "";

async function tempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "voxen-state-"));
  directories.push(directory);
  return directory;
}

beforeAll(async () => {
  contractPath = join(await tempDir(), "contract.json");
});

afterEach(async () => {
  useStateBackendForTests(createMemoryStateBackend());
});

afterAll(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function contract(name: string, make: () => StateBackend): void {
  describe(`${name} backend contract`, () => {
    it("round-trips nested state through read and write", async () => {
      const backend = make();
      await backend.write((document) => {
        document.counters["turn.ok"] = 3;
        document.sessions["abc"] = {
          messages: [{ role: "user", content: "hello" }],
          createdAt: 1,
          lastAccessAt: 2,
        };
      });

      expect(await backend.read((document) => document.counters["turn.ok"])).toBe(3);
      expect(
        await backend.read((document) => document.sessions["abc"].messages[0].content),
      ).toBe("hello");
    });

    it("round-trips account and usage records", async () => {
      const backend = make();
      await backend.write((document) => {
        document.accounts["acct-1"] = {
          id: "acct-1",
          name: "Ada",
          email: "ada@example.com",
          keyHash: "hash",
          plan: "pro",
          role: "user",
          status: "active",
          createdAt: "2026-11-22T00:00:00.000Z",
        };
        document.usage["acct-1:2026-11-22"] = {
          accountId: "acct-1",
          date: "2026-11-22",
          requests: 3,
          audioSeconds: 12,
          outputTokens: 50,
          costMicros: 100,
          updatedAt: "2026-11-22T00:00:00.000Z",
        };
      });

      expect(
        await backend.read((document) => ({
          plan: document.accounts["acct-1"].plan,
          requests: document.usage["acct-1:2026-11-22"].requests,
        })),
      ).toEqual({ plan: "pro", requests: 3 });
    });

    it("resets one section without touching the others", async () => {
      const backend = make();
      await backend.write((document) => {
        document.counters["turn.ok"] = 1;
        document.samples["turn.total"] = [10];
      });

      await backend.reset("samples");

      expect(await backend.read((document) => document.counters["turn.ok"])).toBe(1);
      expect(await backend.read((document) => document.samples["turn.total"])).toBeUndefined();
    });
  });
}

contract("memory", () => createMemoryStateBackend());
contract("file", () => createFileStateBackend(contractPath));

describe("file backend", () => {
  it("shares one document across instances using the same file", async () => {
    const path = join(await tempDir(), "state.json");
    const first = createFileStateBackend(path);
    const second = createFileStateBackend(path);

    await first.write((document) => {
      document.counters["shared"] = 7;
    });

    expect(await second.read((document) => document.counters["shared"])).toBe(7);
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      counters: { shared: 7 },
    });
  });

  it("fails closed on a corrupt state file", async () => {
    const path = join(await tempDir(), "state.json");
    await writeFile(path, "{not json", "utf8");
    const backend = createFileStateBackend(path);

    await expect(
      backend.read((document) => document.rate),
    ).rejects.toThrow();
  });

  it("backs all stateful modules with the selected adapter", async () => {
    const path = join(await tempDir(), "state.json");
    const shared = createFileStateBackend(path);
    useStateBackendForTests(shared);

    const originalRequests = config.rateLimitRequests;
    const originalBudget = config.dailyRequestBudget;
    config.rateLimitRequests = 1;
    config.dailyRequestBudget = 1;
    try {
      expect((await rateLimit("shared-key")).allowed).toBe(true);
      expect((await rateLimit("shared-key")).allowed).toBe(false);
      expect(await consumeDailyBudget()).toBe(true);
      expect(await consumeDailyBudget()).toBe(false);
      await addMessage("shared-session", "user", "hello");
      expect((await getHistory("shared-session"))[0].content).toBe("hello");
      await startRealtimeSession("shared-session");
    } finally {
      config.rateLimitRequests = originalRequests;
      config.dailyRequestBudget = originalBudget;
    }

    expect(
      await shared.read((document) => ({
        rate: document.rate["shared-key"].count,
        budget: document.budget.used,
        message: document.sessions["shared-session"].messages[1]?.content,
        sessions: document.realtime["shared-session"].sessions,
      })),
    ).toEqual({ rate: 2, budget: 1, message: "hello", sessions: 1 });
  });
});
