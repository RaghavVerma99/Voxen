"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import AccessGate from "./AccessGate";
import {
  AlertIcon,
  CloseIcon,
  MicIcon,
  PlayIcon,
  RefreshIcon,
  SendIcon,
  SparkIcon,
  StopIcon,
  UserIcon,
  WaveIcon,
} from "./Icons";

type Status = "idle" | "recording" | "thinking" | "speaking";
type EntryRole = "user" | "agent" | "error";

interface Entry {
  id: string;
  role: EntryRole;
  text: string;
  at: number;
}

interface ReplyPayload {
  transcript?: string;
  reply?: string;
  audio?: string | null;
  detail?: { message?: string };
}

const SESSION_KEY = "voxen.session_id";
const CODE_KEY = "voxen.access_code";
const MAX_RECORD_SECONDS = 60;
const MAX_MESSAGE_CHARS = 4_000;

const STATUS_LABEL: Record<Status, string> = {
  idle: "Ready",
  recording: "Listening",
  thinking: "Thinking",
  speaking: "Speaking",
};

const SUGGESTIONS = [
  "What changed in AI this week?",
  "Explain HTTPS like I'm new to it.",
  "Help me prep for a system design interview.",
  "Compare Postgres and SQLite for a side project.",
];

function randomId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Fallback for non-secure contexts (e.g. testing over a LAN IP).
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => {
    const random = (Math.random() * 16) | 0;
    const value = char === "x" ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
}

function createSessionId(): string {
  const id = randomId();
  window.localStorage.setItem(SESSION_KEY, id);
  return id;
}

function getOrCreateSessionId(): string {
  return window.localStorage.getItem(SESSION_KEY) || createSessionId();
}

function formatTime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function pickMimeType(): string | null {
  if (typeof MediaRecorder === "undefined") return null;
  if (typeof MediaRecorder.isTypeSupported !== "function") return null;
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/ogg;codecs=opus",
  ];
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) ?? null;
}

async function verifyAccess(code: string): Promise<boolean> {
  try {
    const response = await fetch("/api/health?verify=1", {
      headers: { "x-access-code": code },
      cache: "no-store",
    });
    return response.ok;
  } catch {
    return false;
  }
}

function WaveBars({ active = false }: { active?: boolean }) {
  return (
    <span className={`wave${active ? " is-active" : ""}`} aria-hidden="true">
      {[0, 1, 2, 3, 4].map((index) => (
        <i key={index} />
      ))}
    </span>
  );
}

function MessageRow({
  entry,
  onDismiss,
}: {
  entry: Entry;
  onDismiss: (id: string) => void;
}) {
  if (entry.role === "error") {
    return (
      <div className="msg msg-error" role="alert">
        <span className="msg-icon">
          <AlertIcon size={16} />
        </span>
        <div className="bubble">{entry.text}</div>
        <button
          type="button"
          className="msg-dismiss"
          onClick={() => onDismiss(entry.id)}
          aria-label="Dismiss error"
        >
          <CloseIcon size={14} />
        </button>
      </div>
    );
  }

  const isUser = entry.role === "user";

  return (
    <div className={`msg ${isUser ? "msg-user" : "msg-agent"}`}>
      <div className="avatar" aria-hidden="true">
        {isUser ? <UserIcon size={17} /> : <WaveIcon size={17} />}
      </div>
      <div className="msg-body">
        <span className="msg-role">{isUser ? "You" : "Voxen"}</span>
        <div className="bubble">{entry.text}</div>
      </div>
    </div>
  );
}

function TypingRow() {
  return (
    <div className="msg msg-agent typing" aria-label="Voxen is thinking">
      <div className="avatar" aria-hidden="true">
        <WaveIcon size={17} />
      </div>
      <div className="msg-body">
        <span className="msg-role">Voxen</span>
        <div className="bubble">
          <span className="dot" />
          <span className="dot" />
          <span className="dot" />
        </div>
      </div>
    </div>
  );
}

export default function VoiceAgent() {
  const [booting, setBooting] = useState(true);
  const [accessRequired, setAccessRequired] = useState(false);
  const [accessCode, setAccessCode] = useState("");
  const [accessBusy, setAccessBusy] = useState(false);
  const [accessError, setAccessError] = useState("");
  const [micSupported, setMicSupported] = useState(true);

  const [sessionId, setSessionId] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackBlocked, setPlaybackBlocked] = useState(false);
  const [lastAudio, setLastAudio] = useState<string | null>(null);

  const sessionRef = useRef("");
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const mimeRef = useRef("audio/webm");
  const startedAtRef = useRef(0);
  const durationRef = useRef(0);
  const discardRef = useRef(false);
  const intervalRef = useRef<number | null>(null);
  const autoStopRef = useRef<number | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const playbackResolveRef = useRef<((ok: boolean) => void) | null>(null);
  const manualStopRef = useRef(false);
  const counterRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const recording = status === "recording";

  const clearTimers = useCallback(() => {
    if (intervalRef.current !== null) {
      window.clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    if (autoStopRef.current !== null) {
      window.clearTimeout(autoStopRef.current);
      autoStopRef.current = null;
    }
  }, []);

  const stopStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  const addEntry = useCallback((role: EntryRole, text: string) => {
    counterRef.current += 1;
    setEntries((previous) => [
      ...previous,
      { id: `entry-${counterRef.current}`, role, text, at: Date.now() },
    ]);
  }, []);

  const dismissEntry = useCallback((id: string) => {
    setEntries((previous) => previous.filter((entry) => entry.id !== id));
  }, []);

  const stopPlayback = useCallback(() => {
    manualStopRef.current = true;
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.currentTime = 0;
    }

    const settle = playbackResolveRef.current;
    playbackResolveRef.current = null;

    if (settle) {
      settle(false);
    } else {
      if (audioRef.current === audio) audioRef.current = null;
      setIsPlaying(false);
    }
  }, []);

  const playAudio = useCallback(
    (base64: string): Promise<boolean> => {
      stopPlayback();
      manualStopRef.current = false;
      const audio = new Audio(`data:audio/mpeg;base64,${base64}`);
      audioRef.current = audio;
      setIsPlaying(true);

      return new Promise((resolve) => {
        let settled = false;
        const done = (ok: boolean) => {
          if (settled) return;
          settled = true;
          audio.onended = null;
          audio.onerror = null;
          if (playbackResolveRef.current === done) {
            playbackResolveRef.current = null;
          }
          if (audioRef.current === audio) audioRef.current = null;
          setIsPlaying(false);
          resolve(ok);
        };

        playbackResolveRef.current = done;
        audio.onended = () => done(true);
        audio.onerror = () => done(false);
        audio.play().catch(() => done(false));
      });
    },
    [stopPlayback],
  );

  const fail = useCallback(
    (error: unknown) => {
      const message =
        error instanceof Error ? error.message : "Something went wrong.";
      addEntry("error", message);
      setStatus("idle");
    },
    [addEntry],
  );

  const authHeaders = useCallback(
    (): Record<string, string> =>
      accessCode ? { "x-access-code": accessCode } : {},
    [accessCode],
  );

  const handleUnauthorized = useCallback(
    (response: Response): boolean => {
      if (response.status !== 401) return false;
      window.localStorage.removeItem(CODE_KEY);
      setAccessCode("");
      setAccessRequired(true);
      return true;
    },
    [],
  );

  useEffect(() => {
    sessionRef.current = getOrCreateSessionId();
    setSessionId(sessionRef.current);
  }, []);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const response = await fetch("/api/health", { cache: "no-store" });
        const data = (await response.json()) as {
          access_required?: boolean;
        };

        if (cancelled) return;

        if (data.access_required) {
          setAccessRequired(true);
          const stored = window.localStorage.getItem(CODE_KEY) ?? "";
          if (stored) {
            const ok = await verifyAccess(stored);
            if (!cancelled && ok) setAccessCode(stored);
          }
        }
      } catch {
        // The app still works without the health probe; requests surface errors.
      } finally {
        if (!cancelled) setBooting(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    setMicSupported(
      typeof window !== "undefined" &&
        typeof window.MediaRecorder !== "undefined" &&
        Boolean(navigator.mediaDevices?.getUserMedia),
    );
  }, []);

  useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [entries, status]);

  useEffect(() => {
    return () => {
      clearTimers();
      stopStream();
      audioRef.current?.pause();
    };
  }, [clearTimers, stopStream]);

  async function handleAccessSubmit(code: string) {
    setAccessBusy(true);
    setAccessError("");
    const ok = await verifyAccess(code);
    setAccessBusy(false);

    if (!ok) {
      setAccessError("That code didn't work. Check it and try again.");
      return;
    }

    window.localStorage.setItem(CODE_KEY, code);
    setAccessCode(code);
  }

  function stopRecording() {
    const recorder = recorderRef.current;
    durationRef.current = Math.max(0, (Date.now() - startedAtRef.current) / 1000);
    clearTimers();
    setElapsed(0);
    setStatus("idle");

    // Stop the recorder before releasing the tracks so the final chunk flushes.
    if (recorder && recorder.state !== "inactive") recorder.stop();
    else recorderRef.current = null;
    stopStream();
  }

  function cancelRecording() {
    discardRef.current = true;
    const recorder = recorderRef.current;
    clearTimers();
    setElapsed(0);
    setStatus("idle");

    if (recorder && recorder.state !== "inactive") recorder.stop();
    else recorderRef.current = null;
    stopStream();
  }

  function onRecordingStopped() {
    stopStream();
    const mime = mimeRef.current;
    const chunks = chunksRef.current;
    chunksRef.current = [];
    recorderRef.current = null;

    if (discardRef.current) {
      discardRef.current = false;
      return;
    }

    const blob = new Blob(chunks, { type: mime });
    if (blob.size === 0) {
      fail(new Error("No audio was captured. Try again."));
      return;
    }

    void submitAudio(blob, mime);
  }

  async function submitAudio(blob: Blob, mime: string) {
    setBusy(true);
    setStatus("thinking");
    setPlaybackBlocked(false);

    try {
      const extension = mime.includes("mp4")
        ? "m4a"
        : mime.includes("ogg")
          ? "ogg"
          : "webm";
      const form = new FormData();
      form.append("audio", blob, `recording.${extension}`);
      form.append("session_id", sessionRef.current);
      form.append("audio_duration", durationRef.current.toFixed(2));

      const response = await fetch("/api/voice", {
        method: "POST",
        body: form,
        headers: authHeaders(),
      });
      const data = (await response.json().catch(() => ({}))) as ReplyPayload;

      if (!response.ok) {
        handleUnauthorized(response);
        throw new Error(
          data.detail?.message || "The request failed. Please try again.",
        );
      }

      if (data.transcript) addEntry("user", data.transcript);
      if (data.reply) addEntry("agent", data.reply);

      if (data.audio) {
        setStatus("speaking");
        const played = await playAudio(data.audio);
        if (!played && !manualStopRef.current) {
          setLastAudio(data.audio);
          setPlaybackBlocked(true);
        }
      }
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
      setStatus("idle");
    }
  }

  async function submitText(raw: string) {
    const message = raw.trim();
    if (!message || busy || recording) return;
    if (message.length > MAX_MESSAGE_CHARS) {
      fail(
        new Error(`Messages are limited to ${MAX_MESSAGE_CHARS} characters.`),
      );
      return;
    }

    setBusy(true);
    setStatus("thinking");
    setPlaybackBlocked(false);
    addEntry("user", message);
    setDraft("");

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...authHeaders(),
        },
        body: JSON.stringify({
          session_id: sessionRef.current,
          message,
          speak: true,
        }),
      });
      const data = (await response.json().catch(() => ({}))) as ReplyPayload;

      if (!response.ok) {
        handleUnauthorized(response);
        throw new Error(
          data.detail?.message || "The request failed. Please try again.",
        );
      }

      if (data.reply) addEntry("agent", data.reply);

      if (data.audio) {
        setStatus("speaking");
        const played = await playAudio(data.audio);
        if (!played && !manualStopRef.current) {
          setLastAudio(data.audio);
          setPlaybackBlocked(true);
        }
      }
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
      setStatus("idle");
    }
  }

  async function startRecording() {
    if (busy || recording || recorderRef.current) return;
    stopPlayback();

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch {
      fail(
        new Error(
          "Microphone access was blocked. Allow microphone permission in your browser and try again.",
        ),
      );
      return;
    }

    const mime = pickMimeType();

    let recorder: MediaRecorder;
    try {
      recorder = mime
        ? new MediaRecorder(stream, { mimeType: mime })
        : new MediaRecorder(stream);
    } catch {
      stream.getTracks().forEach((track) => track.stop());
      fail(new Error("This browser cannot record audio."));
      return;
    }

    streamRef.current = stream;
    recorderRef.current = recorder;
    mimeRef.current = recorder.mimeType || mime || "audio/webm";
    chunksRef.current = [];
    discardRef.current = false;
    startedAtRef.current = Date.now();

    recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) chunksRef.current.push(event.data);
    });
    recorder.addEventListener("stop", onRecordingStopped, { once: true });

    recorder.start(250);
    setElapsed(0);
    setStatus("recording");

    intervalRef.current = window.setInterval(() => {
      setElapsed((Date.now() - startedAtRef.current) / 1000);
    }, 200);
    autoStopRef.current = window.setTimeout(
      stopRecording,
      MAX_RECORD_SECONDS * 1000,
    );
  }

  function toggleRecording() {
    if (recording) stopRecording();
    else void startRecording();
  }

  async function resetConversation() {
    if (busy) return;
    stopPlayback();
    setEntries([]);
    setDraft("");
    setStatus("idle");
    setPlaybackBlocked(false);
    setLastAudio(null);

    const previous = sessionRef.current;
    const next = createSessionId();
    sessionRef.current = next;
    setSessionId(next);

    try {
      await fetch("/api/reset", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...authHeaders(),
        },
        body: JSON.stringify({ session_id: previous }),
      });
    } catch {
      // The new client-side session is still clean; the old one expires by TTL.
    }
  }

  async function playLastReply() {
    if (!lastAudio) return;
    setStatus("speaking");
    const ok = await playAudio(lastAudio);
    setPlaybackBlocked(!ok && !manualStopRef.current);
    setStatus("idle");
  }

  const turns = entries.filter((entry) => entry.role !== "error").length;

  if (booting) {
    return (
      <main className="boot" role="status" aria-live="polite">
        <span className="spinner" aria-hidden="true" />
        <span>Loading Voxen…</span>
      </main>
    );
  }

  if (accessRequired && !accessCode) {
    return (
      <AccessGate
        onSubmit={(code) => void handleAccessSubmit(code)}
        busy={accessBusy}
        error={accessError}
      />
    );
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            <WaveIcon size={22} />
          </span>
          <div className="brand-text">
            <strong>Voxen</strong>
            <span>AI voice agent</span>
          </div>
        </div>

        <div className="topbar-actions">
          <span
            className={`status status-${status}`}
            role="status"
            aria-live="polite"
          >
            <i aria-hidden="true" />
            {STATUS_LABEL[status]}
          </span>
          <button
            type="button"
            className="btn"
            onClick={() => void resetConversation()}
            disabled={busy || entries.length === 0}
          >
            <RefreshIcon size={16} />
            <span>New session</span>
          </button>
        </div>
      </header>

      <div className="workspace">
        <main className="chat">
          <div
            className={`chat-scroll${
              entries.length === 0 && status !== "thinking" ? " is-empty" : ""
            }`}
            ref={scrollRef}
          >
            {entries.length === 0 && status !== "thinking" ? (
              <section className="hero">
                <span className="hero-eyebrow">
                  <SparkIcon size={14} />
                  Voice-first assistant
                </span>
                <h1>Talk through anything, out loud.</h1>
                <p>
                  Ask a question, search the web, or think through a problem.
                  Voxen listens, reasons, and answers in a natural voice.
                </p>
                <div className="suggestions">
                  {SUGGESTIONS.map((suggestion) => (
                    <button
                      key={suggestion}
                      type="button"
                      className="chip"
                      onClick={() => void submitText(suggestion)}
                      disabled={busy}
                    >
                      {suggestion}
                    </button>
                  ))}
                </div>
              </section>
            ) : (
              <div className="thread" aria-live="polite">
                {entries.map((entry) => (
                  <MessageRow
                    key={entry.id}
                    entry={entry}
                    onDismiss={dismissEntry}
                  />
                ))}
                {status === "thinking" ? <TypingRow /> : null}
              </div>
            )}
          </div>

          <div className="composer">
            {isPlaying ? (
              <div className="now-playing">
                <WaveBars active />
                <span>Speaking the reply…</span>
                <button type="button" className="link" onClick={stopPlayback}>
                  Stop
                </button>
              </div>
            ) : playbackBlocked && lastAudio ? (
              <div className="now-playing blocked">
                <PlayIcon size={14} />
                <span>Your browser blocked autoplay.</span>
                <button
                  type="button"
                  className="link"
                  onClick={() => void playLastReply()}
                >
                  Play reply
                </button>
              </div>
            ) : null}

            <form
              className="composer-inner"
              onSubmit={(event) => {
                event.preventDefault();
                void submitText(draft);
              }}
            >
              <button
                type="button"
                className={`mic${recording ? " is-recording" : ""}`}
                onClick={toggleRecording}
                disabled={!micSupported || (busy && !recording)}
                aria-label={recording ? "Stop recording" : "Start recording"}
                title={
                  micSupported
                    ? recording
                      ? "Stop and send"
                      : "Start recording"
                    : "Microphone is not supported in this browser"
                }
              >
                {recording ? <StopIcon size={18} /> : <MicIcon size={20} />}
              </button>

              <input
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder={
                  recording
                    ? `Listening… ${formatTime(elapsed)}`
                    : "Type a message, or tap the mic to speak"
                }
                aria-label="Message"
                maxLength={MAX_MESSAGE_CHARS}
                disabled={recording}
                enterKeyHint="send"
                autoComplete="off"
              />

              <button
                type="submit"
                className="send"
                disabled={!draft.trim() || busy || recording}
                aria-label="Send message"
              >
                <SendIcon size={18} />
              </button>
            </form>

            <div className="composer-meta">
              {recording ? (
                <div className="recording-meta">
                  <span className="rec-dot" aria-hidden="true" />
                  <span>
                    {formatTime(elapsed)}{" "}
                    <span className="muted">/ {formatTime(MAX_RECORD_SECONDS)}</span>
                  </span>
                  <WaveBars active />
                  <button
                    type="button"
                    className="link danger"
                    onClick={cancelRecording}
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <span className="hint">
                  Tap the mic to talk · Enter to send · Replies play
                  automatically
                </span>
              )}
            </div>
          </div>
        </main>

        <aside className="rail" aria-label="Session details">
          <section className="card">
            <div className="card-head">
              <h2>Session</h2>
              <span className={`pill pill-${status}`}>
                {STATUS_LABEL[status]}
              </span>
            </div>
            <dl className="stats">
              <div>
                <dt>Turns</dt>
                <dd>{turns}</dd>
              </div>
              <div>
                <dt>Input</dt>
                <dd>{micSupported ? "Voice + text" : "Text only"}</dd>
              </div>
              <div>
                <dt>ID</dt>
                <dd className="mono">{sessionId.slice(0, 8) || "—"}</dd>
              </div>
            </dl>
          </section>

          <section className="card">
            <h2>How it works</h2>
            <ol className="steps">
              <li>
                <span>1</span>
                <div>
                  <strong>Speak or type</strong>
                  <p>Ask anything in natural language.</p>
                </div>
              </li>
              <li>
                <span>2</span>
                <div>
                  <strong>Voxen reasons</strong>
                  <p>It searches the web when freshness matters.</p>
                </div>
              </li>
              <li>
                <span>3</span>
                <div>
                  <strong>Listen</strong>
                  <p>The answer is spoken back to you.</p>
                </div>
              </li>
            </ol>
          </section>

          <section className="card subtle">
            <h2>Tip</h2>
            <p>
              Follow-up questions keep the same context. Start a new session for
              a clean slate.
            </p>
          </section>
        </aside>
      </div>
    </div>
  );
}
