import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RealtimeVoiceSession } from "@/app/components/voice-agent/realtime";

type Listener = (event: any) => void;

class FakeDataChannel {
  readyState: RTCDataChannelState = "open";
  readonly messages: Array<Record<string, unknown>> = [];
  private readonly listeners = new Map<string, Listener[]>();

  addEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
    if (type === "open") queueMicrotask(() => listener({ type: "open" }));
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((item) => item !== listener),
    );
  }

  send(data: string): void {
    this.messages.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(): void {
    this.readyState = "closed";
  }

  emit(type: string, payload: unknown = {}): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ type, ...(payload as object) });
    }
  }

  message(payload: unknown): void {
    this.emit("message", { data: JSON.stringify(payload) });
  }
}

class FakePeerConnection {
  iceGatheringState: RTCIceGatheringState = "complete";
  connectionState: RTCPeerConnectionState = "connected";
  localDescription = { type: "offer" as const, sdp: "local-sdp" };
  channel!: FakeDataChannel;
  private readonly listeners = new Map<string, Listener[]>();

  addEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((item) => item !== listener),
    );
  }

  addTrack(): void {}

  createDataChannel(): FakeDataChannel {
    this.channel = new FakeDataChannel();
    return this.channel;
  }

  async createOffer(): Promise<{ type: "offer"; sdp: string }> {
    return this.localDescription;
  }

  async setLocalDescription(): Promise<void> {}

  async setRemoteDescription(): Promise<void> {}

  close(): void {}
}

let lastPeer: FakePeerConnection | null = null;
let usageBodies: Array<Record<string, unknown>> = [];

function installBrowserGlobals(): void {
  lastPeer = null;
  usageBodies = [];

  vi.stubGlobal("RTCPeerConnection", class extends FakePeerConnection {
    constructor() {
      super();
      lastPeer = this;
    }
  });
  vi.stubGlobal("MediaStream", class {});
  vi.stubGlobal("navigator", {
    mediaDevices: {
      getUserMedia: async () => ({
        getAudioTracks: () => [{ enabled: true, stop() {} }],
      }),
    },
  });
  vi.stubGlobal("document", {
    body: { appendChild() {} },
    createElement: () => ({
      autoplay: false,
      hidden: false,
      srcObject: null,
      play: async () => {},
      remove() {},
    }),
  });
  vi.stubGlobal("window", {
    setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms),
    clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
  });

  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/realtime/token")) {
      return new Response(JSON.stringify({ value: "ek_test" }), { status: 200 });
    }
    if (url.endsWith("/api/realtime/usage")) {
      usageBodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
    }
    if (url === "https://api.openai.com/v1/realtime/calls") {
      return new Response("remote-sdp", { status: 200 });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
}

beforeEach(installBrowserGlobals);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("RealtimeVoiceSession tool bridge", () => {
  it("defers the final turn until tool output has been sent", async () => {
    let completed = 0;
    const session = new RealtimeVoiceSession({
      onResponseDone: () => {
        completed += 1;
      },
      onToolCall: async () => JSON.stringify({ ok: true, handoff: true }),
    });

    await session.start({ sessionId: "live-1", accessCode: "" });
    const channel = lastPeer!.channel;

    channel.message({
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "I need a human.",
    });
    channel.message({ type: "response.output_text.delta", delta: "Connecting." });
    channel.message({
      type: "response.function_call_arguments.done",
      call_id: "call-1",
      name: "handoff_to_human",
      arguments: '{"reason":"caller asked"}',
    });
    channel.message({ type: "response.done", response: {} });

    expect(completed).toBe(0);
    await vi.waitFor(() => {
      expect(
        channel.messages.some(
          (message) =>
            (message.item as { type?: string } | undefined)?.type ===
            "function_call_output",
        ),
      ).toBe(true);
    });
    expect(completed).toBe(0);
    expect(channel.messages.at(-1)).toEqual({ type: "response.create" });

    channel.message({ type: "response.done", response: {} });
    expect(completed).toBe(1);

    await session.stop();
    expect(usageBodies.at(-1)).toMatchObject({ session_id: "live-1" });
  });

  it("releases a minted reservation when setup fails", async () => {
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/api/realtime/token")) {
        return new Response(JSON.stringify({ value: "ek_test" }), { status: 200 });
      }
      if (url.endsWith("/api/realtime/usage")) {
        usageBodies.push({ url });
        return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
      }
      return new Response("signaling failed", { status: 500 });
    });

    const session = new RealtimeVoiceSession({});
    await expect(
      session.start({ sessionId: "live-2", accessCode: "" }),
    ).rejects.toThrow("Realtime signaling failed");
    expect(usageBodies).toHaveLength(1);
  });

  it("sends a tool result with a continuation response", async () => {
    const session = new RealtimeVoiceSession({});
    await session.start({ sessionId: "live-3", accessCode: "" });
    const channel = lastPeer!.channel;

    session.sendToolOutput("call-9", '{"ok":true}');
    expect(channel.messages).toEqual([
      {
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: "call-9",
          output: '{"ok":true}',
        },
      },
      { type: "response.create" },
    ]);

    await session.stop();
  });
});
