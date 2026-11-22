import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { config } from "@/lib/config";
import { activeToolSchemas, runTool } from "@/lib/tools";
import { getWorkflow, listAppointments } from "@/lib/workflow-store";

let directory = "";
let counter = 0;

function parse(value: string): Record<string, unknown> {
  return JSON.parse(value) as Record<string, unknown>;
}

function nextWeekday(): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + 10);
  while (date.getUTCDay() === 0 || date.getUTCDay() === 6) {
    date.setUTCDate(date.getUTCDate() + 1);
  }
  return date.toISOString().slice(0, 10);
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "voxen-tools-"));
  config.workflowStorePath = join(directory, "workflow.json");
  config.workflowEnabled = true;
  config.appointmentMinutes = 30;
  config.confirmationTtlMs = 10 * 60 * 1000;
  config.shareTtlMs = 24 * 60 * 60 * 1000;
  counter += 1;
});

afterAll(async () => {
  config.workflowEnabled = true;
  config.confirmationTtlMs = 10 * 60 * 1000;
  config.shareTtlMs = 24 * 60 * 60 * 1000;
  if (directory) await rm(directory, { recursive: true, force: true });
});

function session(): string {
  return `tools-session-${counter}`;
}

describe("workflow tools", () => {
  it("exposes workflow tools only when the flag is enabled", async () => {
    const confirmSchema = activeToolSchemas().find(
      (tool) => tool.function.name === "confirm_appointment",
    );
    expect(confirmSchema?.function.parameters).toMatchObject({
      required: ["confirm", "confirmation_token"],
    });
    expect(activeToolSchemas().map((tool) => tool.function.name)).toEqual([
      "search_web",
      "find_appointment_slots",
      "prepare_appointment",
      "confirm_appointment",
      "cancel_appointment",
      "handoff_to_human",
    ]);

    config.workflowEnabled = false;
    try {
      expect(activeToolSchemas().map((tool) => tool.function.name)).toEqual([
        "search_web",
      ]);
      expect(
        parse(
          await runTool("confirm_appointment", "{}", { sessionId: session() }),
        ),
      ).toEqual({ ok: false, reason: "workflow is disabled" });
    } finally {
      config.workflowEnabled = true;
    }
  });

  it("requires explicit confirmation before persisting a booking", async () => {
    const id = session();
    const day = nextWeekday();
    const startsAt = `${day}T10:00:00.000Z`;

    const slots = parse(
      await runTool("find_appointment_slots", JSON.stringify({ day }), { sessionId: id }),
    );
    expect(slots.slots).toContain(startsAt);

    const prepared = parse(
      await runTool(
        "prepare_appointment",
        JSON.stringify({ starts_at: startsAt, email: "user@example.com" }),
        { sessionId: id },
      ),
    );
    expect(prepared).toMatchObject({
      ok: true,
      starts_at: startsAt,
      requires_confirmation: true,
    });
    expect(typeof prepared.confirmation_token).toBe("string");
    expect(prepared.confirmation_expires_at).toEqual(expect.any(String));
    expect(JSON.stringify(await getWorkflow(id))).not.toContain(
      String(prepared.confirmation_token),
    );
    expect((await getWorkflow(id))?.stage).toBe("awaiting_confirmation");

    const notConfirmed = parse(
      await runTool("confirm_appointment", JSON.stringify({ confirm: false }), {
        sessionId: id,
      }),
    );
    expect(notConfirmed.ok).toBe(false);

    const wrongToken = parse(
      await runTool(
        "confirm_appointment",
        JSON.stringify({ confirm: true, confirmation_token: "wrong" }),
        { sessionId: id },
      ),
    );
    expect(wrongToken.ok).toBe(false);

    const confirmed = parse(
      await runTool(
        "confirm_appointment",
        JSON.stringify({
          confirm: true,
          confirmation_token: prepared.confirmation_token,
        }),
        { sessionId: id, source: "realtime" },
      ),
    );
    expect(confirmed.ok).toBe(true);
    expect(confirmed.confirmation_code).toMatch(/^VXN-/);
    expect((await getWorkflow(id))?.stage).toBe("confirmed");

    const [appointment] = await listAppointments(id);
    expect(appointment).toMatchObject({
      source: "realtime",
      createdBy: "realtime",
      confirmedAt: expect.any(String),
    });

    const secondAttempt = parse(
      await runTool(
        "confirm_appointment",
        JSON.stringify({
          confirm: true,
          confirmation_token: prepared.confirmation_token,
        }),
        { sessionId: id },
      ),
    );
    expect(secondAttempt.ok).toBe(false);
  });

  it("expires a confirmation token", async () => {
    config.confirmationTtlMs = -1;
    const id = session();
    const prepared = parse(
      await runTool(
        "prepare_appointment",
        JSON.stringify({
          starts_at: `${nextWeekday()}T12:00:00.000Z`,
          email: "user@example.com",
        }),
        { sessionId: id },
      ),
    );

    const result = parse(
      await runTool(
        "confirm_appointment",
        JSON.stringify({
          confirm: true,
          confirmation_token: prepared.confirmation_token,
        }),
        { sessionId: id },
      ),
    );
    expect(result).toEqual({
      ok: false,
      reason: "the confirmation token expired; prepare the slot again",
    });
    expect(await listAppointments(id)).toEqual([]);
  });

  it("rejects malformed scheduling arguments without booking", async () => {
    const id = session();
    const result = parse(
      await runTool(
        "prepare_appointment",
        JSON.stringify({ starts_at: "not-a-date", email: "bad" }),
        { sessionId: id },
      ),
    );
    expect(result.ok).toBe(false);
    expect(await getWorkflow(id)).toBeNull();
  });

  it("cancels with a code and records human handoff", async () => {
    const id = session();
    const startsAt = `${nextWeekday()}T11:00:00.000Z`;
    const prepared = parse(
      await runTool(
        "prepare_appointment",
        JSON.stringify({ starts_at: startsAt, email: "user@example.com" }),
        { sessionId: id },
      ),
    );
    expect(prepared.ok).toBe(true);

    const confirmed = parse(
      await runTool(
        "confirm_appointment",
        JSON.stringify({
          confirm: true,
          confirmation_token: prepared.confirmation_token,
        }),
        { sessionId: id },
      ),
    );
    const code = confirmed.confirmation_code as string;

    expect(
      parse(
        await runTool("cancel_appointment", JSON.stringify({ confirmation_code: code })),
      ),
    ).toEqual({ ok: true });

    const handoff = parse(
      await runTool(
        "handoff_to_human",
        JSON.stringify({ reason: "billing question" }),
        { sessionId: id },
      ),
    );
    expect(handoff).toMatchObject({ ok: true, handoff: true });
    expect(await getWorkflow(id)).toMatchObject({
      stage: "handed_off",
      handoffReason: "billing question",
    });
  });
});
