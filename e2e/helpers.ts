import type { Page, Route } from "@playwright/test";

export async function fulfillJson(
  route: Route,
  body: unknown,
  status = 200,
): Promise<void> {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

export function sseBody(events: Array<[string, unknown]>): string {
  return events
    .map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    .join("");
}

/** A short, valid mono WAV so a resumed reply can actually finish. */
export function tinyWavBase64(): string {
  const sampleRate = 8_000;
  const samples = 400;
  const dataBytes = samples * 2;
  const buffer = Buffer.alloc(44 + dataBytes);

  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataBytes, 40);

  return buffer.toString("base64");
}

export async function installBaseRoutes(
  page: Page,
  options: { realtime?: boolean } = {},
): Promise<void> {
  await page.route("**/api/health*", (route) =>
    fulfillJson(route, {
      status: "ok",
      access_required: false,
      realtime_enabled: options.realtime === true,
    }),
  );
  const workflowResponse = {
    enabled: true,
    workflow: null,
    appointments: [],
    stats: { appointments: 0, workflows: 0 },
  };
  await page.route("**/api/workflow", (route) =>
    fulfillJson(route, workflowResponse),
  );
  await page.route("**/api/workflow?*", (route) =>
    fulfillJson(route, workflowResponse),
  );
  await page.route("**/api/history*", (route) =>
    fulfillJson(route, { history: [] }),
  );
}

/**
 * Replaces WebRTC with an in-page data channel double. Only the browser bridge
 * is under test; OpenAI's transport is mocked at the SDP boundary.
 */
export const REALTIME_INIT_SCRIPT = `
window.__oaiMessages = [];

class FakeDataChannel {
  constructor() {
    this.readyState = "connecting";
    this.listeners = new Map();
  }
  addEventListener(type, listener) {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
    if (type === "open") {
      queueMicrotask(() => {
        this.readyState = "open";
        listener({ type: "open" });
      });
    }
  }
  removeEventListener(type, listener) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((item) => item !== listener));
  }
  send(data) {
    window.__oaiMessages.push(JSON.parse(data));
  }
  close() {
    this.readyState = "closed";
  }
  message(payload) {
    for (const listener of this.listeners.get("message") ?? []) {
      listener({ type: "message", data: JSON.stringify(payload) });
    }
  }
}

class FakePeerConnection {
  constructor() {
    this.iceGatheringState = "complete";
    this.connectionState = "connected";
    this.localDescription = { type: "offer", sdp: "local-sdp" };
    this.listeners = new Map();
  }
  addEventListener() {}
  removeEventListener() {}
  addTrack() {}
  createDataChannel() {
    window.__oaiChannel = new FakeDataChannel();
    return window.__oaiChannel;
  }
  async createOffer() { return this.localDescription; }
  async setLocalDescription() {}
  async setRemoteDescription() {}
  close() {}
}

Object.defineProperty(navigator, "mediaDevices", {
  configurable: true,
  value: {
    getUserMedia: async () => ({
      getAudioTracks: () => [{ enabled: true, stop() {} }],
    }),
  },
});
window.RTCPeerConnection = FakePeerConnection;
window.MediaStream = class {};
HTMLAudioElement.prototype.play = async () => {};
`;
