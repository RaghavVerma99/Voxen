import { describe, expect, it } from "vitest";
import { parseRealtimeEvent } from "@/lib/realtime-events";

describe("parseRealtimeEvent", () => {
  it("reads user transcription deltas and final text", () => {
    expect(
      parseRealtimeEvent({
        type: "conversation.item.input_audio_transcription.delta",
        delta: "Book ",
      }),
    ).toEqual({ userDelta: "Book " });

    expect(
      parseRealtimeEvent({
        type: "conversation.item.input_audio_transcription.completed",
        transcript: "Book a slot.",
      }),
    ).toEqual({ userTranscript: "Book a slot." });
  });

  it("reads assistant text and audio transcript deltas", () => {
    expect(
      parseRealtimeEvent({
        type: "response.output_text.delta",
        delta: "Hello",
      }),
    ).toEqual({ assistantDelta: "Hello" });

    expect(
      parseRealtimeEvent({
        type: "response.output_audio_transcript.delta",
        delta: " there",
      }),
    ).toEqual({ assistantDelta: " there" });
  });

  it("maps VAD barge-in and response interruption", () => {
    expect(
      parseRealtimeEvent({ type: "input_audio_buffer.speech_started" }),
    ).toEqual({ speechStarted: true });
    expect(parseRealtimeEvent({ type: "response.interrupted" })).toEqual({
      interrupted: true,
    });
  });

  it("extracts output tokens from response.done", () => {
    expect(
      parseRealtimeEvent({
        type: "response.done",
        response: { usage: { output_tokens: 128, total_tokens: 900 } },
      }),
    ).toEqual({ responseDone: true, outputTokens: 128 });

    expect(parseRealtimeEvent({ type: "response.done", response: {} })).toEqual({
      responseDone: true,
    });
  });

  it("normalizes provider errors", () => {
    expect(
      parseRealtimeEvent({
        type: "error",
        error: { message: "Rate limit reached" },
      }),
    ).toEqual({ error: "Rate limit reached" });
  });

  it("accepts JSON strings and ignores unrelated frames", () => {
    expect(
      parseRealtimeEvent('{"type":"response.done","response":{"usage":{"output_tokens":7}}}'),
    ).toEqual({ responseDone: true, outputTokens: 7 });
    expect(parseRealtimeEvent("not json")).toBeNull();
    expect(parseRealtimeEvent({ type: "session.created" })).toBeNull();
    expect(parseRealtimeEvent(null)).toBeNull();
  });
});
