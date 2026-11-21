import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { GET as getTranscript } from "@/app/api/transcript/[token]/route";
import { GET as getWorkflow } from "@/app/api/workflow/route";
import { POST as postSummary } from "@/app/api/workflow/summary/route";
import { config } from "@/lib/config";
import { appendTurn } from "@/lib/conversation";
import { updateWorkflow } from "@/lib/workflow-store";

let directory = "";
let counter = 0;

async function bodyOf(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "voxen-workflow-routes-"));
  config.workflowStorePath = join(directory, "workflow.json");
  config.workflowEnabled = true;
  config.accessCode = "";
  config.rateLimitRequests = 1_000;
  counter += 1;
});

afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

function session(): string {
  return `workflow-route-${counter}`;
}

describe("workflow routes", () => {
  it("returns only the requested session's workflow state", async () => {
    const id = session();
    await updateWorkflow(id, { stage: "awaiting_confirmation" });

    const response = await getWorkflow(
      new NextRequest(`http://localhost/api/workflow?session_id=${id}`),
    );
    const body = await bodyOf(response);

    expect(response.status).toBe(200);
    expect(body.session_id).toBe(id);
    expect(body.enabled).toBe(true);
    expect(body.workflow).toMatchObject({ stage: "awaiting_confirmation" });
    expect(body.appointments).toEqual([]);
  });

  it("gates workflow state behind the shared access code", async () => {
    config.accessCode = "a-long-enough-access-code";
    const denied = await getWorkflow(
      new NextRequest(`http://localhost/api/workflow?session_id=${session()}`),
    );
    expect(denied.status).toBe(401);

    const allowed = await getWorkflow(
      new NextRequest(`http://localhost/api/workflow?session_id=${session()}`, {
        headers: { "x-access-code": config.accessCode },
      }),
    );
    expect(allowed.status).toBe(200);
  });

  it("creates a shareable transcript without exposing the session id", async () => {
    const id = session();
    appendTurn(id, "Book a slot", "Which day works?");

    const response = await postSummary(
      new NextRequest("http://localhost/api/workflow/summary", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session_id: id }),
      }),
    );
    const body = await bodyOf(response);

    expect(response.status).toBe(200);
    expect(body.share_url).toMatch(/^\/api\/transcript\/[a-f0-9]{32}$/);
    expect(body.summary).toMatchObject({
      headline: expect.any(String),
      action_items: expect.any(Array),
    });

    const token = body.share_token as string;
    const shared = await getTranscript(
      new NextRequest(`http://localhost/api/transcript/${token}`),
      { params: Promise.resolve({ token }) },
    );
    const sharedBody = await bodyOf(shared);

    expect(shared.status).toBe(200);
    expect(sharedBody.transcript).toContain("You: Book a slot");
    expect(JSON.stringify(sharedBody)).not.toContain(id);
  });

  it("returns 404 for an unknown transcript token", async () => {
    const response = await getTranscript(
      new NextRequest("http://localhost/api/transcript/missing"),
      { params: Promise.resolve({ token: "missing" }) },
    );
    expect(response.status).toBe(404);
    expect(await bodyOf(response)).toMatchObject({
      detail: { error_code: "NOT_FOUND" },
    });
  });
});
