"use client";

import { parseRealtimeEvent } from "../../../lib/realtime-events";
import type { Milestone, Stage } from "../../../lib/telemetry";
import { ApiError, errorFromResponse } from "./stream";

const OPENAI_REALTIME_CALLS = "https://api.openai.com/v1/realtime/calls";
const SIGNAL_TIMEOUT_MS = 15_000;
const MAX_TOOL_ROUNDS = 4;

export interface RealtimeFunctionCallPayload {
  callId: string;
  name: string;
  argumentsJson: string;
  itemId?: string;
}

export interface RealtimeTurnMetrics {
  elapsedMs: number;
  milestonesMs: Partial<Record<Milestone, number>>;
  stagesMs: Partial<Record<Stage, number>>;
  interrupted: boolean;
}

export interface RealtimeSessionHandlers {
  onUserDelta?: (text: string) => void;
  onUserTranscript?: (text: string) => void;
  onAssistantDelta?: (text: string) => void;
  onSpeechStarted?: () => void;
  onInterrupted?: () => void;
  /** Called only for the final response, after any tool continuations finish. */
  onResponseDone?: (metrics: RealtimeTurnMetrics) => void;
  /** Executes a provider function call on the server and returns its output. */
  onToolCall?: (call: RealtimeFunctionCallPayload) => Promise<string>;
  onError?: (message: string) => void;
  onClosed?: () => void;
  onAudioBlocked?: () => void;
}

interface TokenPayload {
  value?: unknown;
}

interface StartOptions {
  sessionId: string;
  accessCode: string;
}

/**
 * Browser transport for the optional full-duplex Realtime path. The standard
 * OpenAI key never reaches this class: it receives a short-lived secret from
 * our own token route and uses it only for the SDP handshake.
 */
export class RealtimeVoiceSession {
  private peer: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private microphone: MediaStream | null = null;
  private audioElement: HTMLAudioElement | null = null;
  private startedAt = 0;
  private outputTokens = 0;
  private stopped = false;
  private sessionId = "";
  private accessCode = "";
  private tokenMinted = false;
  private closedNotified = false;

  private pendingCalls: RealtimeFunctionCallPayload[] = [];
  private toolRound = 0;
  private turnStartedAt = 0;
  private turnMilestones: Partial<Record<Milestone, number>> = {};
  private interrupted = false;

  constructor(private readonly handlers: RealtimeSessionHandlers) {}

  async start({ sessionId, accessCode }: StartOptions): Promise<void> {
    if (
      typeof RTCPeerConnection === "undefined" ||
      !navigator.mediaDevices?.getUserMedia
    ) {
      throw new Error("This browser does not support WebRTC voice sessions.");
    }

    this.sessionId = sessionId;
    this.accessCode = accessCode;
    this.stopped = false;
    this.closedNotified = false;

    const token = await this.mintToken();
    this.tokenMinted = true;

    try {
      await this.openSession(token);
      // The reservation is now owned by the normal /usage report on stop().
      this.tokenMinted = false;
    } catch (err) {
      await this.releaseReservation();
      this.tokenMinted = false;
      this.cleanup();
      throw err;
    }
  }

  sendText(text: string): void {
    this.beginTurn();
    const channel = this.openChannel();
    channel.send(
      JSON.stringify({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text }],
        },
      }),
    );
    channel.send(JSON.stringify({ type: "response.create" }));
  }

  /** Manual barge-in; server VAD also interrupts automatically. */
  interrupt(): void {
    const channel = this.channel;
    if (!channel || channel.readyState !== "open") return;
    this.interrupted = true;
    channel.send(JSON.stringify({ type: "response.cancel" }));
    channel.send(JSON.stringify({ type: "input_audio_buffer.clear" }));
    this.handlers.onInterrupted?.();
  }

  setMuted(muted: boolean): void {
    for (const track of this.microphone?.getAudioTracks() ?? []) {
      track.enabled = !muted;
    }
  }

  /** Sends one tool result and asks the provider to continue the response. */
  sendToolOutput(callId: string, output: string): void {
    const channel = this.openChannel();
    this.sendFunctionOutput(channel, callId, output);
    channel.send(JSON.stringify({ type: "response.create" }));
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;

    const channel = this.channel;
    if (channel?.readyState === "open") {
      channel.send(JSON.stringify({ type: "response.cancel" }));
      channel.close();
    }
    this.cleanup();

    if (this.startedAt > 0) {
      const audioSeconds =
        Math.round(((Date.now() - this.startedAt) / 1_000) * 10) / 10;
      await this.reportUsage(audioSeconds);
    }
  }

  private async openSession(token: string): Promise<void> {
    const peer = new RTCPeerConnection();
    this.peer = peer;

    const element = document.createElement("audio");
    element.autoplay = true;
    element.hidden = true;
    document.body.appendChild(element);
    this.audioElement = element;

    peer.addEventListener("track", (event) => {
      element.srcObject = event.streams[0] ?? new MediaStream([event.track]);
      void element.play().catch(() => this.handlers.onAudioBlocked?.());
    });
    peer.addEventListener("connectionstatechange", () => {
      if (peer.connectionState === "failed" && !this.stopped) {
        void this.stop();
        this.notifyClosed();
      }
    });

    this.microphone = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (this.stopped) {
      this.cleanup();
      return;
    }
    for (const track of this.microphone.getAudioTracks()) {
      peer.addTrack(track, this.microphone);
    }

    const channel = peer.createDataChannel("oai-events");
    this.channel = channel;
    const channelReady = this.watchChannel(channel);
    channel.addEventListener("message", (event) => this.onMessage(event.data));

    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    await this.waitForIce(peer);
    if (this.stopped) {
      this.cleanup();
      return;
    }

    const localSdp = peer.localDescription?.sdp;
    if (!localSdp) throw new Error("The browser could not create a WebRTC offer.");

    const sdpResponse = await fetch(OPENAI_REALTIME_CALLS, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/sdp",
      },
      body: localSdp,
      signal: AbortSignal.timeout(SIGNAL_TIMEOUT_MS),
      cache: "no-store",
    });
    if (!sdpResponse.ok) {
      throw new Error(
        `Realtime signaling failed (HTTP ${sdpResponse.status}).`,
      );
    }

    const answer = await sdpResponse.text();
    if (!answer.trim()) throw new Error("Realtime signaling returned no answer.");
    if (this.stopped) {
      this.cleanup();
      return;
    }

    await peer.setRemoteDescription({ type: "answer", sdp: answer });
    await channelReady;
    this.startedAt = Date.now();
  }

  private async mintToken(): Promise<string> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (this.accessCode) headers["x-access-code"] = this.accessCode;

    const response = await fetch("/api/realtime/token", {
      method: "POST",
      headers,
      body: JSON.stringify({ session_id: this.sessionId }),
      cache: "no-store",
    });
    if (!response.ok) {
      if (response.status === 401) {
        throw new ApiError(401, "Realtime access was denied.");
      }
      throw await errorFromResponse(response);
    }

    const payload = (await response.json()) as TokenPayload;
    if (typeof payload.value !== "string" || !payload.value) {
      throw new Error("The Realtime token service returned an empty secret.");
    }
    return payload.value;
  }

  private async reportUsage(audioSeconds: number): Promise<void> {
    await this.postUsage(audioSeconds);
  }

  /** Releases a token reservation when setup fails before the session starts. */
  private async releaseReservation(): Promise<void> {
    await this.postUsage(0);
  }

  private async postUsage(audioSeconds: number): Promise<void> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (this.accessCode) headers["x-access-code"] = this.accessCode;

    try {
      const response = await fetch("/api/realtime/usage", {
        method: "POST",
        headers,
        body: JSON.stringify({
          session_id: this.sessionId,
          audio_seconds: audioSeconds,
          output_tokens: this.outputTokens,
        }),
        cache: "no-store",
      });
      if (!response.ok) {
        const error = await errorFromResponse(response);
        this.handlers.onError?.(error.message);
      }
    } catch {
      // A failed usage report must not leave a stopped session stuck open.
    }
  }

  private openChannel(): RTCDataChannel {
    const channel = this.channel;
    if (!channel || channel.readyState !== "open" || this.stopped) {
      throw new Error("The live voice session is not connected.");
    }
    return channel;
  }

  private onMessage(data: unknown): void {
    let parsed: unknown = data;
    if (typeof data === "string") {
      try {
        parsed = JSON.parse(data);
      } catch {
        return;
      }
    }

    const update = parseRealtimeEvent(parsed);
    if (!update) return;
    if (update.userDelta || update.speechStarted) this.beginTurn();
    if (update.userDelta) this.handlers.onUserDelta?.(update.userDelta);
    if (update.userTranscript) {
      this.beginTurn();
      this.mark("transcript");
      this.handlers.onUserTranscript?.(update.userTranscript);
    }
    if (update.assistantDelta) {
      this.beginTurn();
      this.mark("first_delta");
      this.handlers.onAssistantDelta?.(update.assistantDelta);
    }
    if (update.audioDelta) {
      this.beginTurn();
      this.mark("first_audio");
    }
    if (update.outputTokens) this.outputTokens += update.outputTokens;
    if (update.speechStarted) this.handlers.onSpeechStarted?.();
    if (update.interrupted) {
      this.interrupted = true;
      this.handlers.onInterrupted?.();
    }
    if (update.functionCall) {
      this.beginTurn();
      this.pendingCalls.push(update.functionCall);
    }
    if (update.responseDone) {
      this.mark("done");
      if (this.pendingCalls.length === 0) {
        this.completeTurn();
      } else {
        const calls = this.pendingCalls;
        this.pendingCalls = [];
        void this.resolveCalls(calls);
      }
    }
    if (update.error) this.handlers.onError?.(update.error);
  }

  private async resolveCalls(calls: RealtimeFunctionCallPayload[]): Promise<void> {
    if (this.toolRound >= MAX_TOOL_ROUNDS) {
      const output = JSON.stringify({
        ok: false,
        reason: "The live tool round limit was reached.",
      });
      for (const call of calls) this.safeSendOutput(call.callId, output);
      this.completeTurn();
      return;
    }
    this.toolRound += 1;

    for (const call of calls) {
      let output: string;
      try {
        output = this.handlers.onToolCall
          ? await this.handlers.onToolCall(call)
          : JSON.stringify({ ok: false, reason: "Tool execution is unavailable." });
      } catch (err) {
        output = JSON.stringify({
          ok: false,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
      this.safeSendOutput(call.callId, output);
    }

    const channel = this.channel;
    if (channel?.readyState === "open" && !this.stopped) {
      channel.send(JSON.stringify({ type: "response.create" }));
    }
  }

  private safeSendOutput(callId: string, output: string): void {
    const channel = this.channel;
    if (!channel || channel.readyState !== "open" || this.stopped) return;
    this.sendFunctionOutput(channel, callId, output);
  }

  private sendFunctionOutput(
    channel: RTCDataChannel,
    callId: string,
    output: string,
  ): void {
    channel.send(
      JSON.stringify({
        type: "conversation.item.create",
        item: { type: "function_call_output", call_id: callId, output },
      }),
    );
  }

  private beginTurn(): void {
    if (this.turnStartedAt > 0) return;
    this.turnStartedAt = performance.now();
    this.turnMilestones = {};
    this.interrupted = false;
    this.toolRound = 0;
  }

  private mark(name: Milestone): void {
    if (this.turnStartedAt === 0 || this.turnMilestones[name] !== undefined) {
      return;
    }
    this.turnMilestones[name] = Math.max(
      0,
      Math.round(performance.now() - this.turnStartedAt),
    );
  }

  private completeTurn(): void {
    if (this.turnStartedAt === 0) return;
    this.mark("complete");
    const milestonesMs = { ...this.turnMilestones };
    const elapsedMs = Math.max(
      0,
      Math.round(performance.now() - this.turnStartedAt),
    );
    const metrics: RealtimeTurnMetrics = {
      elapsedMs,
      milestonesMs,
      stagesMs: deriveStages(milestonesMs),
      interrupted: this.interrupted,
    };
    this.turnStartedAt = 0;
    this.turnMilestones = {};
    this.pendingCalls = [];
    this.toolRound = 0;
    this.interrupted = false;
    this.handlers.onResponseDone?.(metrics);
  }

  private notifyClosed(): void {
    if (this.closedNotified) return;
    this.closedNotified = true;
    this.handlers.onClosed?.();
  }

  private watchChannel(channel: RTCDataChannel): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        reject(new Error("Timed out while opening the Realtime data channel."));
      }, SIGNAL_TIMEOUT_MS);

      channel.addEventListener(
        "open",
        () => {
          window.clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      channel.addEventListener(
        "close",
        () => {
          window.clearTimeout(timer);
          if (!this.stopped) {
            void this.stop();
            this.notifyClosed();
          }
          reject(new Error("The Realtime data channel closed."));
        },
        { once: true },
      );
    });
  }

  private waitForIce(peer: RTCPeerConnection): Promise<void> {
    if (peer.iceGatheringState === "complete") return Promise.resolve();

    return new Promise((resolve) => {
      const timer = window.setTimeout(() => {
        peer.removeEventListener("icegatheringstatechange", onState);
        resolve();
      }, SIGNAL_TIMEOUT_MS);

      function onState(this: RTCPeerConnection) {
        if (this.iceGatheringState !== "complete") return;
        window.clearTimeout(timer);
        peer!.removeEventListener("icegatheringstatechange", onState);
        resolve();
      }
      peer.addEventListener("icegatheringstatechange", onState);
      onState.call(peer);
    });
  }

  private cleanup(): void {
    for (const track of this.microphone?.getAudioTracks() ?? []) {
      track.stop();
    }
    this.microphone = null;
    if (this.audioElement) {
      this.audioElement.srcObject = null;
      this.audioElement.remove();
      this.audioElement = null;
    }
    this.channel?.close();
    this.channel = null;
    this.peer?.close();
    this.peer = null;
  }
}

function deriveStages(
  milestones: Partial<Record<Milestone, number>>,
): Partial<Record<Stage, number>> {
  const stages: Partial<Record<Stage, number>> = {};
  if (milestones.transcript !== undefined) stages.stt = milestones.transcript;
  if (
    milestones.transcript !== undefined &&
    milestones.first_delta !== undefined
  ) {
    stages.llm = Math.max(0, milestones.first_delta - milestones.transcript);
  }
  if (
    milestones.first_delta !== undefined &&
    milestones.first_audio !== undefined
  ) {
    stages.tts = Math.max(0, milestones.first_audio - milestones.first_delta);
  }
  return stages;
}
