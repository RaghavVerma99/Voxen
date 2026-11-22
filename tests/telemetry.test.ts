import { beforeEach, describe, expect, it } from "vitest";

import {
  incrementCounter,
  recordTiming,
  resetTelemetry,
  startTurnTrace,
  telemetrySnapshot,
} from "@/lib/telemetry";

beforeEach(() => {
  resetTelemetry();
});

describe("turn telemetry", () => {
  it("records milestones relative to turn start", () => {
    const trace = startTurnTrace({ requestId: "trace-1", sessionHash: "sha256:abc" });
    trace.milestone("transcript");
    trace.milestone("first_delta");
    trace.milestone("transcript"); // repeated milestones are ignored
    trace.milestone("done");

    const snapshot = trace.snapshot();
    expect(snapshot.requestId).toBe("trace-1");
    expect(snapshot.sessionHash).toBe("sha256:abc");
    expect(snapshot.status).toBe("ok");
    expect(snapshot.milestonesMs.transcript).toBeLessThanOrEqual(
      snapshot.milestonesMs.first_delta!,
    );
    expect(snapshot.milestonesMs.first_delta).toBeLessThanOrEqual(
      snapshot.milestonesMs.done!,
    );
    expect(snapshot.milestonesMs.complete).toBeUndefined();
  });

  it("accumulates repeated stage durations", async () => {
    const trace = startTurnTrace({ requestId: "trace-2" });

    const first = trace.stage("tts");
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
    first();
    first(); // double-end is a no-op

    const second = trace.stage("tts");
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
    second();

    expect(trace.snapshot().stagesMs.tts).toBeGreaterThan(0);
    expect(telemetrySnapshot().timings["stage.tts"].count).toBe(2);
  });

  it("replays browser-measured live turn markers", () => {
    const trace = startTurnTrace({
      requestId: "trace-live",
      transport: "realtime",
      replay: {
        totalMs: 740,
        milestonesMs: { transcript: 140, first_delta: 420, done: 700 },
        stagesMs: { stt: 140, llm: 280 },
      },
    });

    expect(trace.snapshot()).toMatchObject({
      transport: "realtime",
      totalMs: 740,
      milestonesMs: { transcript: 140, first_delta: 420, done: 700 },
      stagesMs: { stt: 140, llm: 280 },
    });

    trace.finish();
    const metrics = telemetrySnapshot();
    expect(metrics.timings["turn.total"].p50).toBe(740);
    expect(metrics.timings["stage.stt"].p50).toBe(140);
    expect(metrics.counters["turn.transport.realtime"]).toBe(1);
  });

  it("freezes the total and records outcome counters on finish", () => {
    const trace = startTurnTrace({ requestId: "trace-3" });
    trace.milestone("complete");
    const finished = trace.finish("LLM_FAILED");
    const firstTotal = finished.totalMs;

    expect(finished.status).toBe("error");
    expect(finished.errorCode).toBe("LLM_FAILED");
    expect(trace.finish("OTHER").errorCode).toBe("LLM_FAILED");
    expect(trace.snapshot().totalMs).toBe(firstTotal);

    const metrics = telemetrySnapshot();
    expect(metrics.counters["turn.error.LLM_FAILED"]).toBe(1);
    expect(metrics.timings["turn.total"].count).toBe(1);
  });
});

describe("metrics registry", () => {
  it("computes p50, p95 and max from bounded samples", () => {
    recordTiming("latency", 10);
    recordTiming("latency", 20);
    recordTiming("latency", 30);
    recordTiming("latency", 100);

    expect(telemetrySnapshot().timings.latency).toEqual({
      count: 4,
      p50: 20,
      p95: 100,
      max: 100,
    });
  });

  it("caps retained samples and tracks arbitrary counters", () => {
    for (let index = 0; index < 600; index += 1) {
      recordTiming("capped", index);
    }
    incrementCounter("audio.sentences", 3);
    incrementCounter("audio.sentences", 2);

    expect(telemetrySnapshot().timings.capped.count).toBe(500);
    expect(telemetrySnapshot().counters["audio.sentences"]).toBe(5);
  });
});
