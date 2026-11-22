import { expect, test, type Page } from "@playwright/test";
import {
  REALTIME_INIT_SCRIPT,
  fulfillJson,
  installBaseRoutes,
  sseBody,
  tinyWavBase64,
} from "./helpers";

declare global {
  interface Window {
    __oaiMessages?: Array<Record<string, unknown>>;
    __oaiChannel?: {
      readyState: string;
      message(payload: unknown): void;
    };
    __playCalls?: number;
    __originalPlay?: typeof HTMLAudioElement.prototype.play;
  }
}

interface LiveHooks {
  onTool?: (body: Record<string, unknown>) => unknown;
  onTurn?: (body: Record<string, unknown>) => unknown;
}

async function openApp(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
}

/** Mocks the signaling boundary so the real browser Realtime bridge runs. */
async function startLive(page: Page, hooks: LiveHooks = {}) {
  let toolBody: Record<string, unknown> | null = null;
  let turnBody: Record<string, unknown> | null = null;
  let usageCount = 0;

  await installBaseRoutes(page, { realtime: true });
  await page.addInitScript(REALTIME_INIT_SCRIPT);
  await page.route("https://api.openai.com/v1/realtime/calls", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/sdp",
      body: "remote-sdp",
    }),
  );
  await page.route("**/api/realtime/token", (route) =>
    fulfillJson(route, { value: "ek_test" }),
  );
  await page.route("**/api/realtime/tool", (route) => {
    toolBody = route.request().postDataJSON() as Record<string, unknown>;
    return fulfillJson(
      route,
      hooks.onTool?.(toolBody) ?? {
        output: JSON.stringify({ ok: true }),
      },
    );
  });
  await page.route("**/api/realtime/turn", (route) => {
    turnBody = route.request().postDataJSON() as Record<string, unknown>;
    return fulfillJson(
      route,
      hooks.onTurn?.(turnBody) ?? {
        history: [],
        workflow: null,
        appointments: [],
      },
    );
  });
  await page.route("**/api/realtime/usage", (route) => {
    usageCount += 1;
    return fulfillJson(route, { status: "ok" });
  });

  await openApp(page);
  await page.getByRole("button", { name: "Live voice" }).click();
  await page.waitForFunction(() => window.__oaiChannel?.readyState === "open");

  return {
    get toolBody() {
      return toolBody;
    },
    get turnBody() {
      return turnBody;
    },
    get usageCount() {
      return usageCount;
    },
  };
}

test.beforeEach(async ({ page }) => {
  await installBaseRoutes(page);
});

test("streams a typed turn and adopts the server session", async ({ page }) => {
  let chatBody: Record<string, unknown> | null = null;
  await page.route("**/api/chat/stream", async (route) => {
    chatBody = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream; charset=utf-8",
      body: sseBody([
        ["session", { session_id: "e2e-session" }],
        ["delta", { text: "Hello from the mock." }],
        [
          "done",
          {
            session_id: "e2e-session",
            reply: "Hello from the mock.",
            history: [
              { role: "user", content: "Say hello" },
              { role: "assistant", content: "Hello from the mock." },
            ],
            spoken: false,
          },
        ],
        ["workflow", { workflow: null, appointments: [] }],
      ]),
    });
  });

  await openApp(page);
  await page.getByRole("button", { name: "Sound on" }).click();
  await page.getByRole("textbox", { name: "Message" }).fill("Say hello");
  await page.getByRole("textbox", { name: "Message" }).press("Enter");

  await expect(page.getByText("Hello from the mock.")).toBeVisible();
  expect(chatBody).toMatchObject({ message: "Say hello", speak: false });
});

test("keeps blocked audio recoverable", async ({ page }) => {
  await page.addInitScript(() => {
    window.__playCalls = 0;
    window.__originalPlay = HTMLAudioElement.prototype.play;
    HTMLAudioElement.prototype.play = () => {
      window.__playCalls = (window.__playCalls ?? 0) + 1;
      return Promise.reject(new DOMException("blocked", "NotAllowedError"));
    };
  });

  await page.route("**/api/chat/stream", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/event-stream; charset=utf-8",
      body: sseBody([
        ["delta", { text: "Audio reply." }],
        ["audio", { index: 0, audio: tinyWavBase64() }],
        [
          "done",
          {
            reply: "Audio reply.",
            history: [{ role: "assistant", content: "Audio reply." }],
            spoken: true,
          },
        ],
      ]),
    }),
  );

  await openApp(page);
  await page.getByRole("textbox", { name: "Message" }).fill("Play audio");
  await page.getByRole("textbox", { name: "Message" }).press("Enter");

  const blocked = page.getByText("Your browser blocked autoplay.");
  await expect(blocked).toBeVisible();
  expect(await page.evaluate(() => window.__playCalls ?? 0)).toBeGreaterThan(0);

  await page.evaluate(() => {
    if (window.__originalPlay) {
      HTMLAudioElement.prototype.play = window.__originalPlay;
    }
  });
  await page.getByRole("button", { name: "Play reply" }).click();
  await expect(blocked).toBeHidden();
});

test("plays a reply when an earlier speech chunk failed", async ({ page }) => {
  await page.route("**/api/chat/stream", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/event-stream; charset=utf-8",
      body: sseBody([
        ["delta", { text: "Fallback reply." }],
        // Index 0 was lost when the primary narrator failed; the queue skips it.
        ["audio", { index: 1, audio: tinyWavBase64() }],
        ["done", { reply: "Fallback reply.", history: [], spoken: true }],
      ]),
    }),
  );

  await openApp(page);
  await page.getByRole("textbox", { name: "Message" }).fill("Speak slowly");
  await page.getByRole("textbox", { name: "Message" }).press("Enter");

  await expect(page.getByText("Fallback reply.")).toBeVisible();
  await expect(page.getByText("Your browser blocked autoplay.")).toHaveCount(0);
  await expect(page.getByText("Speaking the reply…")).toHaveCount(0);
});

test("gates the app behind an access code", async ({ page }) => {
  await page.route("**/api/health*", (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("verify") === "1") {
      if (route.request().headers()["x-access-code"] === "correct-horse") {
        return fulfillJson(route, { status: "ok" });
      }
      return fulfillJson(
        route,
        { detail: { error_code: "ACCESS_DENIED", message: "Denied" } },
        401,
      );
    }
    return fulfillJson(route, {
      status: "ok",
      access_required: true,
      realtime_enabled: false,
    });
  });

  await page.goto("/");
  const code = page.getByLabel("Access code");
  await expect(code).toBeVisible();
  await code.fill("wrong-code");
  await page.getByRole("button", { name: "Enter" }).click();
  await expect(page.locator(".gate-error")).toContainText("didn't work");

  await code.fill("correct-horse");
  await page.getByRole("button", { name: "Enter" }).click();
  await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
  expect(
    await page.evaluate(() => localStorage.getItem("voxen.access_code")),
  ).toBe("correct-horse");
});

test("creates and revokes an expiring share link", async ({ page }) => {
  let revokedToken = "";
  await page.route("**/api/workflow/summary", (route) =>
    fulfillJson(route, {
      summary: { headline: "Appointment call", action_items: ["Confirm by email"] },
      share_token: "share-token-123",
      share_url: "/api/transcript/share-token-123",
      share_expires_at: "2099-01-01T00:00:00.000Z",
    }),
  );
  await page.route("**/api/workflow/share/revoke", (route) => {
    const body = route.request().postDataJSON() as { share_token?: string };
    revokedToken = body.share_token ?? "";
    return fulfillJson(route, { revoked: true });
  });

  await openApp(page);
  await page.getByRole("button", { name: "Share", exact: true }).click();

  const shareBox = page.locator(".summary-box");
  await expect(shareBox).toContainText("Appointment call");
  await expect(shareBox).toContainText("Expires");
  await expect(
    shareBox.getByRole("link", { name: "Open shareable transcript" }),
  ).toHaveAttribute("href", "/api/transcript/share-token-123");

  await shareBox.getByRole("button", { name: "Revoke" }).click();
  await expect(shareBox).toHaveCount(0);
  expect(revokedToken).toBe("share-token-123");
});

test("executes live tools and commits only the final Realtime turn", async ({
  page,
}) => {
  const live = await startLive(page, {
    onTool: () => ({ output: JSON.stringify({ ok: true, handoff: true }) }),
  });

  await page.getByRole("textbox", { name: "Message" }).fill("I need a human.");
  await page.getByRole("textbox", { name: "Message" }).press("Enter");

  await page.evaluate(() => {
    window.__oaiChannel?.message({
      type: "response.function_call_arguments.done",
      call_id: "call-1",
      name: "handoff_to_human",
      arguments: '{"reason":"live e2e"}',
    });
    window.__oaiChannel?.message({ type: "response.done", response: {} });
  });

  await expect.poll(() => live.toolBody).toMatchObject({
    name: "handoff_to_human",
    call_id: "call-1",
  });
  await page.waitForFunction(() =>
    window.__oaiMessages?.some(
      (message) =>
        (message.item as { type?: string } | undefined)?.type ===
        "function_call_output",
    ),
  );
  expect(live.turnBody).toBeNull();

  await page.waitForFunction(() =>
    window.__oaiMessages?.some((message) => message.type === "response.create"),
  );
  await page.evaluate(() => {
    window.__oaiChannel?.message({ type: "response.done", response: {} });
  });

  await expect.poll(() => live.turnBody).toMatchObject({
    user_text: "I need a human.",
    interrupted: false,
  });
  expect(live.turnBody).toMatchObject({
    elapsed_ms: expect.any(Number),
    milestones_ms: expect.any(Object),
    stages_ms: expect.any(Object),
  });

  await page.locator("main").getByRole("button", { name: "End live" }).click();
  await expect.poll(() => live.usageCount).toBe(1);
});

test("reports a barge-in from the live turn to telemetry", async ({ page }) => {
  const live = await startLive(page);

  await page.getByRole("textbox", { name: "Message" }).fill("Keep talking.");
  await page.getByRole("textbox", { name: "Message" }).press("Enter");

  await page.evaluate(() => {
    window.__oaiChannel?.message({
      type: "response.output_audio_transcript.delta",
      delta: "I am speaking.",
    });
    window.__oaiChannel?.message({ type: "response.interrupted" });
    window.__oaiChannel?.message({ type: "response.done", response: {} });
  });

  await expect.poll(() => live.turnBody).toMatchObject({
    user_text: "Keep talking.",
    assistant_text: "I am speaking.",
    interrupted: true,
  });
  await expect(page.getByText("Live", { exact: true }).first()).toBeVisible();

  await page.locator("main").getByRole("button", { name: "End live" }).click();
  await expect.poll(() => live.usageCount).toBe(1);
});
