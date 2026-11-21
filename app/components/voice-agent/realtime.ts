"use client";

import { parseRealtimeEvent } from "../../../lib/realtime-events";
import { ApiError, errorFromResponse } from "./stream";

const OPENAI_REALTIME_CALLS = "https://api.openai.com/v1/realtime/calls";
const SIGNAL_TIMEOUT_MS = 15_000;

export interface RealtimeSessionHandlers {
  onUserDelta?: (text: string) => void;
  onUserTranscript?: (text: string) => void;
  onAssistantDelta?: (text: string) => void;
  onSpeechStarted?: () => void;
  onInterrupted?: () => void;
  onResponseDone?: () => void;
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

    const token = await this.mintToken();
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
      if (peer.connectionState === "failed" && !this.stopped) void this.stop();
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

  sendText(text: string): void {
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
    channel.send(JSON.stringify({ type: "response.cancel" }));
    channel.send(JSON.stringify({ type: "input_audio_buffer.clear" }));
    this.handlers.onInterrupted?.();
  }

  setMuted(muted: boolean): void {
    for (const track of this.microphone?.getAudioTracks() ?? []) {
      track.enabled = !muted;
    }
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
    if (update.userDelta) this.handlers.onUserDelta?.(update.userDelta);
    if (update.userTranscript) this.handlers.onUserTranscript?.(update.userTranscript);
    if (update.assistantDelta) this.handlers.onAssistantDelta?.(update.assistantDelta);
    if (update.outputTokens) this.outputTokens += update.outputTokens;
    if (update.speechStarted) this.handlers.onSpeechStarted?.();
    if (update.interrupted) this.handlers.onInterrupted?.();
    if (update.responseDone) this.handlers.onResponseDone?.();
    if (update.error) this.handlers.onError?.(update.error);
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
            this.handlers.onClosed?.();
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
