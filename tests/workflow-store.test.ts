import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { config } from "@/lib/config";
import { AppError } from "@/lib/errors";
import {
  bookAppointment,
  cancelAppointment,
  createShare,
  getShare,
  getWorkflow,
  listAppointments,
  revokeShare,
  updateWorkflow,
  workflowStats,
} from "@/lib/workflow-store";

let directory = "";
let counter = 0;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "voxen-workflow-"));
  config.workflowStorePath = join(directory, "workflow.json");
  config.appointmentMinutes = 30;
  config.confirmationTtlMs = 10 * 60 * 1000;
  config.shareTtlMs = 24 * 60 * 60 * 1000;
  counter += 1;
});

afterAll(async () => {
  config.confirmationTtlMs = 10 * 60 * 1000;
  config.shareTtlMs = 24 * 60 * 60 * 1000;
  if (directory) await rm(directory, { recursive: true, force: true });
});

function session(): string {
  return `workflow-session-${counter}`;
}

describe("persisted appointment store", () => {
  it("stores workflow drafts across reads", async () => {
    const id = session();
    expect(await getWorkflow(id)).toBeNull();

    const result = await updateWorkflow(id, {
      stage: "collecting",
      draft: { email: "user@example.com" },
    });
    expect(result.stage).toBe("collecting");
    expect((await getWorkflow(id))?.draft.email).toBe("user@example.com");
  });

  it("books, rejects a duplicate slot, and frees it after cancellation", async () => {
    const id = session();
    const startsAt = "2027-01-12T14:00:00.000Z";

    const first = await bookAppointment({ sessionId: id, startsAt });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.appointment.endsAt).toBe("2027-01-12T14:30:00.000Z");
    expect(first.appointment.confirmationCode).toMatch(/^VXN-[A-F0-9]{6}$/);
    expect((await getWorkflow(id))?.stage).toBe("confirmed");

    const duplicate = await bookAppointment({ sessionId: session(), startsAt });
    expect(duplicate).toEqual({ ok: false, reason: "slot_taken" });

    expect(
      await cancelAppointment(first.appointment.confirmationCode.toLowerCase()),
    ).toBe(true);
    expect(await listAppointments()).toHaveLength(0);

    const rebooked = await bookAppointment({ sessionId: session(), startsAt });
    expect(rebooked.ok).toBe(true);
  });

  it("does not cancel another session's appointment", async () => {
    const booked = await bookAppointment({
      sessionId: session(),
      startsAt: "2027-01-13T09:00:00.000Z",
    });
    if (!booked.ok) throw new Error("expected booking to succeed");

    expect(
      await cancelAppointment(booked.appointment.confirmationCode, "other-session"),
    ).toBe(false);
    expect(await listAppointments()).toHaveLength(1);
  });

  it("fails closed when the store is corrupt", async () => {
    await writeFile(config.workflowStorePath, "{not json", "utf8");
    await expect(getWorkflow(session())).rejects.toBeInstanceOf(AppError);
  });

  it("reports confirmed appointment counts", async () => {
    const id = session();
    await updateWorkflow(id, { stage: "collecting" });
    await bookAppointment({ sessionId: id, startsAt: "2027-01-14T10:00:00.000Z" });

    expect(await workflowStats()).toMatchObject({ appointments: 1, workflows: 1 });
  });

  it("records who created, confirmed, and cancelled an appointment", async () => {
    const id = session();
    const booked = await bookAppointment({
      sessionId: id,
      startsAt: "2027-01-15T10:00:00.000Z",
      source: "sse",
    });
    if (!booked.ok) throw new Error("expected booking to succeed");

    expect(booked.appointment).toMatchObject({
      source: "sse",
      createdBy: "sse",
      confirmedAt: expect.any(String),
    });
    expect(
      await cancelAppointment(
        booked.appointment.confirmationCode,
        id,
        "realtime",
      ),
    ).toBe(true);

    const { readFile } = await import("node:fs/promises");
    const persisted = JSON.parse(await readFile(config.workflowStorePath, "utf8")) as {
      appointments: Array<Record<string, unknown>>;
    };
    expect(persisted.appointments[0]).toMatchObject({
      cancelledBy: "realtime",
      cancelledAt: expect.any(String),
    });
  });

  it("expires and revokes share links", async () => {
    const id = session();
    const share = await createShare({
      sessionId: id,
      summary: "Summary",
      transcript: "Transcript",
    });
    expect(share.expiresAt).not.toBe(share.createdAt);
    expect((await getShare(share.token))?.token).toBe(share.token);

    expect(await revokeShare(share.token, "other-session")).toBe(false);
    expect(await revokeShare(share.token, id)).toBe(true);
    expect(await getShare(share.token)).toBeNull();

    config.shareTtlMs = -1;
    const expired = await createShare({
      sessionId: id,
      summary: "Expired",
      transcript: "Expired transcript",
    });
    expect(await getShare(expired.token)).toBeNull();
  });
});
