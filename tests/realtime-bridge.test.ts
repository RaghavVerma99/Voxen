import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { POST as postTool } from "@/app/api/realtime/tool/route";
import { POST as postTurn } from "@/app/api/realtime/turn/route";
import { config } from "@/lib/config";
import { reset } from "@/lib/conversation";
import { resetTelemetry, telemetrySnapshot } from "@/lib/telemetry";
import { getWorkflow } from "@/lib/workflow-store";

let directory = "";
let counter = 0;

function session(): string {
  counter += 1;
  return `bridge-session-${counter}`;
}

function request(path: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function bodyOf(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "voxen-realtime-bridge-"));
  config.workflowStorePath = join(directory, "workflow.json");
  config.workflowEnabled = true;
  config.realtimeEnabled = true;
  config.accessCode = "";
  config.rateLimitRequests = 10_000;
  config.dailyRequestBudget = 100_000;
  resetTelemetry();
});

afterAll(async () => {
  config.workflowEnabled = true;
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe("realtime tool route", () => {
  it("executes allowed tools against the server-owned session", async () => {
    const id = session();
    const response = await postTool(
      request("/api/realtime/tool", {
        session_id: id,
        call_id: "call-1",
        name: "handoff_to_human",
        arguments: '{"reason":"Live caller requested a person"}',
      }),
    );
    const body = await bodyOf(response);

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      session_id: id,
      call_id: "call-1",
      name: "handoff_to_human",
    });
    expect(JSON.parse(String(body.output))).toEqual({
      ok: true,
      handoff: true,
      reason: "Live caller requested a person",
    });
    expect((await getWorkflow(id))?.stage).toBe("handed_off");
  });

  it("rejects unknown tools and disabled Realtime", async () => {
    const unknown = await postTool(
      request("/api/realtime/tool", {
        session_id: session(),
        call_id: "call-1",
        name: "drop_database",
        arguments: "{}",
      }),
    );
    expect(unknown.status).toBe(400);
    expect(await bodyOf(unknown)).toMatchObject({
      detail: { error_code: "INVALID_BODY" },
    });

    config.realtimeEnabled = false;
    const disabled = await postTool(
      request("/api/realtime/tool", {
        session_id: session(),
        call_id: "call-2",
        name: "handoff_to_human",
        arguments: "{}",
      }),
    );
    expect(disabled.status).toBe(503);
  });
});

describe("realtime turn route", () => {
  it("commits live text, refreshes workflow, and records transport telemetry", async () => {
    const id = session();
    const response = await postTurn(
      request("/api/realtime/turn", {
        session_id: id,
        user_text: "Book a live appointment.",
        assistant_text: "I have prepared a slot for you.",
        elapsed_ms: 820,
        milestones_ms: {
          transcript: 120,
          first_delta: 480,
          done: 790,
          complete: 815,
        },
        stages_ms: { stt: 120, llm: 360, tts: 210 },
      }),
    );
    const body = await bodyOf(response);

    expect(response.status).toBe(200);
    expect(body.history).toEqual([
      { role: "user", content: "Book a live appointment." },
      { role: "assistant", content: "I have prepared a slot for you." },
    ]);
    expect(body.workflow).toBeNull();
    expect(body.appointments).toEqual([]);

    const metrics = telemetrySnapshot();
    expect(metrics.counters["turn.transport.realtime"]).toBe(1);
    expect(metrics.timings["turn.total"].p50).toBe(820);
    expect(metrics.timings["stage.llm"].p50).toBe(360);
  });

  it("records interrupted turns and appends to existing history", async () => {
    const id = session();
    await postTurn(
      request("/api/realtime/turn", {
        session_id: id,
        user_text: "First live question.",
        assistant_text: "First live answer.",
      }),
    );
    const response = await postTurn(
      request("/api/realtime/turn", {
        session_id: id,
        user_text: "Wait,",
        assistant_text: "",
        interrupted: true,
      }),
    );
    const body = await bodyOf(response);

    expect(response.status).toBe(200);
    expect(body.history).toHaveLength(3);
    expect(telemetrySnapshot().counters["realtime.interrupted"]).toBe(1);
    reset(id);
  });

  it("rejects empty turns and disabled Realtime", async () => {
    const empty = await postTurn(
      request("/api/realtime/turn", { session_id: session(), user_text: "  " }),
    );
    expect(empty.status).toBe(400);

    config.realtimeEnabled = false;
    const disabled = await postTurn(
      request("/api/realtime/turn", {
        session_id: session(),
        user_text: "Hello",
        assistant_text: "Hi",
      }),
    );
    expect(disabled.status).toBe(503);
  });
});
