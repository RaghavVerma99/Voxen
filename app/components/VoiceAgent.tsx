"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import AccessGate from "./AccessGate";
import {
  MicIcon,
  PlayIcon,
  RefreshIcon,
  SendIcon,
  SparkIcon,
  StopIcon,
  WaveIcon,
} from "./Icons";
import {
  MessageRow,
  TypingRow,
  WaveBars,
  type Entry,
} from "./voice-agent/Messages";
import { RealtimeVoiceSession } from "./voice-agent/realtime";
import { ApiError, consumeSse, errorFromResponse } from "./voice-agent/stream";
import { useAudioQueue } from "./voice-agent/useAudioQueue";
import { useRecorder } from "./voice-agent/useRecorder";

type Status = "idle" | "recording" | "thinking" | "speaking" | "live";

interface HistoryPayload {
  history?: Array<{ role: string; content: string }>;
}

interface WorkflowSnapshot {
  stage: string;
  draft?: { startsAt?: string; email?: string; name?: string };
  handoffReason?: string;
}

interface AppointmentRecord {
  confirmationCode: string;
  startsAt: string;
  endsAt: string;
  status: string;
}

interface WorkflowPayload {
  workflow?: WorkflowSnapshot | null;
  appointments?: AppointmentRecord[];
}

interface ShareState {
  headline: string;
  actionItems: string[];
  url: string;
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
  live: "Live",
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

type AccessResult = "ok" | "denied" | "rate_limited" | "unavailable";

async function verifyAccess(code: string): Promise<AccessResult> {
  try {
    const response = await fetch("/api/health?verify=1", {
      headers: { "x-access-code": code },
      cache: "no-store",
    });
    if (response.ok) return "ok";
    if (response.status === 429) return "rate_limited";
    return "denied";
  } catch {
    return "unavailable";
  }
}

export default function VoiceAgent() {
  const [booting, setBooting] = useState(true);
  const [accessRequired, setAccessRequired] = useState(false);
  const [accessCode, setAccessCode] = useState("");
  const [accessBusy, setAccessBusy] = useState(false);
  const [accessError, setAccessError] = useState("");

  const [sessionId, setSessionId] = useState("");
  const [realtimeAvailable, setRealtimeAvailable] = useState(false);
  const [liveMode, setLiveMode] = useState(false);
  const [status, setStatus] = useState<Status>("idle");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [muted, setMuted] = useState(false);
  const [workflow, setWorkflow] = useState<WorkflowSnapshot | null>(null);
  const [appointments, setAppointments] = useState<AppointmentRecord[]>([]);
  const [share, setShare] = useState<ShareState | null>(null);

  const sessionRef = useRef("");
  const counterRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const streamAbortRef = useRef<AbortController | null>(null);
  const liveRef = useRef<RealtimeVoiceSession | null>(null);
  const liveUserEntryRef = useRef<string | null>(null);
  const liveAgentEntryRef = useRef<string | null>(null);
  const textBufferRef = useRef<Map<string, string>>(new Map());
  const flushFrameRef = useRef<number | null>(null);
  const hydratedRef = useRef("");
  const activityRef = useRef(false);
  const mutedRef = useRef(muted);
  const recordingRef = useRef(false);

  mutedRef.current = muted;

  const audio = useAudioQueue();

  const addEntry = useCallback((role: Entry["role"], text: string): string => {
    counterRef.current += 1;
    const id = `entry-${counterRef.current}`;
    setEntries((previous) => [
      ...previous,
      { id, role, text, at: Date.now() },
    ]);
    activityRef.current = true;
    return id;
  }, []);

  const dismissEntry = useCallback((id: string) => {
    setEntries((previous) => previous.filter((entry) => entry.id !== id));
  }, []);

  const flushText = useCallback(() => {
    flushFrameRef.current = null;
    if (textBufferRef.current.size === 0) return;

    const updates = new Map(textBufferRef.current);
    textBufferRef.current.clear();
    setEntries((previous) =>
      previous.map((entry) => {
        const delta = updates.get(entry.id);
        return delta ? { ...entry, text: entry.text + delta } : entry;
      }),
    );
  }, []);

  const queueText = useCallback(
    (id: string, delta: string) => {
      textBufferRef.current.set(
        id,
        (textBufferRef.current.get(id) ?? "") + delta,
      );
      if (flushFrameRef.current === null) {
        flushFrameRef.current = window.requestAnimationFrame(flushText);
      }
    },
    [flushText],
  );

  const flushNow = useCallback(() => {
    if (flushFrameRef.current !== null) {
      window.cancelAnimationFrame(flushFrameRef.current);
      flushFrameRef.current = null;
    }
    flushText();
  }, [flushText]);

  const replaceEntryText = useCallback((id: string, text: string) => {
    setEntries((previous) =>
      previous.map((entry) => (entry.id === id ? { ...entry, text } : entry)),
    );
  }, []);

  const fail = useCallback(
    (error: unknown) => {
      const message =
        error instanceof Error ? error.message : "Something went wrong.";
      addEntry("error", message);
      setStatus("idle");
    },
    [addEntry],
  );

  const recorder = useRecorder({
    maxSeconds: MAX_RECORD_SECONDS,
    disabled: false,
    onStart: () => {
      streamAbortRef.current?.abort();
      audio.stop();
      setBusy(false);
    },
    onComplete: (blob, mime, duration) => {
      void submitAudio(blob, mime, duration);
    },
    onError: (message) => fail(new Error(message)),
  });

  recordingRef.current = recorder.recording;

  const authHeaders = useCallback(
    (): Record<string, string> =>
      accessCode ? { "x-access-code": accessCode } : {},
    [accessCode],
  );

  const handleUnauthorized = useCallback((response: Response): boolean => {
    if (response.status !== 401) return false;
    window.localStorage.removeItem(CODE_KEY);
    setAccessCode("");
    setAccessRequired(true);
    return true;
  }, []);

  const applyWorkflow = useCallback((payload: WorkflowPayload) => {
    setWorkflow(payload.workflow ?? null);
    setAppointments(payload.appointments ?? []);
  }, []);

  const loadWorkflow = useCallback(
    async (id: string) => {
      try {
        const response = await fetch(
          `/api/workflow?session_id=${encodeURIComponent(id)}`,
          { headers: authHeaders(), cache: "no-store" },
        );
        if (!response.ok) return;
        applyWorkflow((await response.json()) as WorkflowPayload);
      } catch {
        // Scheduling state is optional; the conversation still works.
      }
    },
    [applyWorkflow, authHeaders],
  );

  const adoptSession = useCallback((id: string) => {
    if (!id || id === sessionRef.current) return;
    sessionRef.current = id;
    hydratedRef.current = id;
    window.localStorage.setItem(SESSION_KEY, id);
    setSessionId(id);
  }, []);

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
          realtime_enabled?: boolean;
        };

        if (cancelled) return;
        setRealtimeAvailable(data.realtime_enabled === true);

        if (data.access_required) {
          setAccessRequired(true);
          const stored = window.localStorage.getItem(CODE_KEY) ?? "";
          if (stored) {
            const result = await verifyAccess(stored);
            if (!cancelled && result === "ok") setAccessCode(stored);
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
    if (recorder.recording) setStatus("recording");
  }, [recorder.recording]);

  useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [entries, status]);

  useEffect(() => {
    return () => {
      streamAbortRef.current?.abort();
      if (flushFrameRef.current !== null) {
        window.cancelAnimationFrame(flushFrameRef.current);
      }
      audio.stop();
      const live = liveRef.current;
      liveRef.current = null;
      void live?.stop();
    };
  }, [audio]);

  useEffect(() => {
    if (!sessionId || booting) return;
    if (accessRequired && !accessCode) return;
    if (hydratedRef.current === sessionId) return;
    hydratedRef.current = sessionId;
    void loadWorkflow(sessionId);

    let cancelled = false;

    (async () => {
      try {
        const response = await fetch("/api/history", {
          headers: { ...authHeaders(), "x-session-id": sessionId },
          cache: "no-store",
        });
        if (!response.ok) return;

        const data = (await response.json()) as HistoryPayload;
        if (cancelled || activityRef.current || !data.history?.length) return;

        setEntries(
          data.history.map((message, index) => ({
            id: `history-${index}`,
            role: message.role === "user" ? "user" : "agent",
            text: message.content,
            at: 0,
          })),
        );
      } catch {
        // History is a convenience; a fresh session still works.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [sessionId, booting, accessRequired, accessCode, authHeaders, loadWorkflow]);

  async function handleAccessSubmit(code: string) {
    setAccessBusy(true);
    setAccessError("");
    const result = await verifyAccess(code);
    setAccessBusy(false);

    if (result === "rate_limited") {
      setAccessError("Too many attempts. Wait a minute and try again.");
      return;
    }
    if (result !== "ok") {
      setAccessError("That code didn't work. Check it and try again.");
      return;
    }

    window.localStorage.setItem(CODE_KEY, code);
    setAccessCode(code);
  }

  async function startLive() {
    if (!realtimeAvailable || liveRef.current || busy) return;

    streamAbortRef.current?.abort();
    audio.stop();
    flushNow();
    liveUserEntryRef.current = null;
    liveAgentEntryRef.current = null;

    const session = new RealtimeVoiceSession({
      onUserDelta: (delta) => {
        if (!liveUserEntryRef.current) {
          liveUserEntryRef.current = addEntry("user", "");
        }
        queueText(liveUserEntryRef.current, delta);
        setStatus("recording");
      },
      onUserTranscript: (transcript) => {
        flushNow();
        if (liveUserEntryRef.current) {
          replaceEntryText(liveUserEntryRef.current, transcript);
        } else {
          addEntry("user", transcript);
        }
        liveUserEntryRef.current = null;
        setStatus("thinking");
      },
      onAssistantDelta: (delta) => {
        if (!liveAgentEntryRef.current) {
          flushNow();
          liveAgentEntryRef.current = addEntry("agent", "");
        }
        queueText(liveAgentEntryRef.current, delta);
        setStatus("speaking");
      },
      onSpeechStarted: () => {
        flushNow();
        liveAgentEntryRef.current = null;
        setStatus("recording");
      },
      onInterrupted: () => {
        flushNow();
        liveAgentEntryRef.current = null;
        setStatus("live");
      },
      onResponseDone: () => {
        flushNow();
        liveUserEntryRef.current = null;
        liveAgentEntryRef.current = null;
        setStatus("live");
        void loadWorkflow(sessionRef.current);
      },
      onError: (message) => addEntry("error", message),
      onAudioBlocked: () =>
        addEntry("error", "Your browser blocked live audio. Tap Sound on to listen."),
      onClosed: () => {
        setLiveMode(false);
        setStatus("idle");
        addEntry(
          "error",
          "The live session ended. Standard voice mode is still available.",
        );
      },
    });

    liveRef.current = session;
    setStatus("thinking");

    try {
      await session.start({
        sessionId: sessionRef.current,
        accessCode,
      });
      setLiveMode(true);
      setStatus("live");
    } catch (error) {
      // A user-initiated stop clears the ref while setup is still in flight.
      if (liveRef.current !== session) return;

      liveRef.current = null;
      await session.stop();

      if (error instanceof ApiError && error.status === 401) {
        window.localStorage.removeItem(CODE_KEY);
        setAccessCode("");
        setAccessRequired(true);
      }

      const message =
        error instanceof Error ? error.message : "Live voice could not start.";
      addEntry("error", `${message} Standard voice mode is still available.`);
      setLiveMode(false);
      setStatus("idle");
    }
  }

  async function stopLive() {
    const session = liveRef.current;
    liveRef.current = null;
    setLiveMode(false);
    setStatus("idle");
    if (session) await session.stop();
  }

  function toggleLive() {
    if (liveMode) void stopLive();
    else void startLive();
  }

  async function runStream(
    response: Response,
    controller: AbortController,
    userEntryId: string | null,
  ): Promise<void> {
    let completed = false;
    // Keep this turn's entry ids local. Shared refs would let an aborted turn
    // dismiss bubbles that belong to the next one.
    let pendingUserId: string | null = userEntryId;
    let agentEntryId: string | null = null;

    try {
      if (!response.ok) {
        handleUnauthorized(response);
        throw await errorFromResponse(response);
      }

      await consumeSse(response, {
        onSession: adoptSession,
        onTranscript: (transcript) => {
          pendingUserId = addEntry("user", transcript);
        },
        onDelta: (text) => {
          if (!agentEntryId) agentEntryId = addEntry("agent", "");
          queueText(agentEntryId, text);
          setStatus("speaking");
        },
        onAudio: (index, chunk) => {
          if (!mutedRef.current) audio.enqueue(index, chunk);
        },
        onWorkflow: (payload) => {
          applyWorkflow(payload as WorkflowPayload);
        },
        onDone: () => {
          completed = true;
        },
      });

      flushNow();

      if (!completed) {
        throw new ApiError(502, "The response stream ended unexpectedly.");
      }

      await audio.waitForIdle();
      if (!recordingRef.current) setStatus("idle");
    } catch (error) {
      flushNow();

      if (completed) return;

      audio.stop();
      if (pendingUserId) dismissEntry(pendingUserId);
      if (agentEntryId) dismissEntry(agentEntryId);

      if (!controller.signal.aborted) fail(error);
    } finally {
      flushNow();
    }
  }

  async function submitText(raw: string) {
    const message = raw.trim();
    if (!message || busy || recorder.recording) return;
    if (message.length > MAX_MESSAGE_CHARS) {
      fail(
        new Error(`Messages are limited to ${MAX_MESSAGE_CHARS} characters.`),
      );
      return;
    }

    setDraft("");

    if (liveMode && liveRef.current) {
      addEntry("user", message);
      setStatus("thinking");
      try {
        liveRef.current.sendText(message);
      } catch (error) {
        fail(error);
      }
      return;
    }

    audio.begin();
    setBusy(true);
    setStatus("thinking");
    const userEntryId = addEntry("user", message);

    const controller = new AbortController();
    streamAbortRef.current = controller;

    try {
      const response = await fetch("/api/chat/stream", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...authHeaders(),
        },
        body: JSON.stringify({
          session_id: sessionRef.current,
          message,
          speak: !muted,
        }),
        signal: controller.signal,
      });

      await runStream(response, controller, userEntryId);
    } catch (error) {
      if (!controller.signal.aborted) fail(error);
    } finally {
      if (streamAbortRef.current === controller) {
        streamAbortRef.current = null;
        setBusy(false);
      }
    }
  }

  async function submitAudio(
    blob: Blob,
    mime: string,
    durationSeconds: number,
  ) {
    audio.begin();
    setBusy(true);
    setStatus("thinking");

    const extension = mime.includes("mp4")
      ? "m4a"
      : mime.includes("ogg")
        ? "ogg"
        : "webm";
    const form = new FormData();
    form.append("audio", blob, `recording.${extension}`);
    form.append("session_id", sessionRef.current);
    form.append("audio_duration", durationSeconds.toFixed(2));
    form.append("speak", String(!muted));

    const controller = new AbortController();
    streamAbortRef.current = controller;

    try {
      const response = await fetch("/api/voice/stream", {
        method: "POST",
        body: form,
        headers: authHeaders(),
        signal: controller.signal,
      });

      await runStream(response, controller, null);
    } catch (error) {
      if (!controller.signal.aborted) fail(error);
    } finally {
      if (streamAbortRef.current === controller) {
        streamAbortRef.current = null;
        setBusy(false);
      }
    }
  }

  function toggleRecording() {
    if (liveMode) return;
    if (recorder.recording) recorder.stop();
    else void recorder.start();
  }

  function cancelRecording() {
    recorder.cancel();
    setStatus("idle");
  }

  function stopSpeaking() {
    if (liveMode) {
      liveRef.current?.interrupt();
      return;
    }
    streamAbortRef.current?.abort();
    audio.stop();
    setStatus("idle");
  }

  function toggleMute() {
    setMuted((previous) => {
      const next = !previous;
      if (next) audio.stop();
      liveRef.current?.setMuted(next);
      return next;
    });
  }

  async function playLastReply() {
    setStatus("speaking");
    await audio.resume();
    if (!recordingRef.current) setStatus("idle");
  }

  async function resetConversation() {
    const live = liveRef.current;
    liveRef.current = null;
    if (live) await live.stop();

    streamAbortRef.current?.abort();
    audio.stop();
    flushNow();
    setLiveMode(false);
    liveUserEntryRef.current = null;
    liveAgentEntryRef.current = null;
    setEntries([]);
    setDraft("");
    setWorkflow(null);
    setAppointments([]);
    setShare(null);
    setStatus("idle");
    setBusy(false);

    const previous = sessionRef.current;
    const next = createSessionId();
    sessionRef.current = next;
    hydratedRef.current = next;
    activityRef.current = false;
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

  async function shareTranscript() {
    try {
      const response = await fetch("/api/workflow/summary", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...authHeaders(),
        },
        body: JSON.stringify({ session_id: sessionRef.current }),
      });
      if (!response.ok) {
        handleUnauthorized(response);
        throw await errorFromResponse(response);
      }

      const data = (await response.json()) as {
        summary?: { headline?: string; action_items?: string[] };
        share_url?: string;
      };
      setShare({
        headline: data.summary?.headline ?? "Session summary",
        actionItems: data.summary?.action_items ?? [],
        url: data.share_url ?? "",
      });
    } catch (error) {
      fail(error);
    }
  }

  const confirmedAppointment = appointments.find(
    (appointment) => appointment.status === "confirmed",
  );
  const workflowLabel = confirmedAppointment
    ? "Booked"
    : workflow?.stage === "awaiting_confirmation"
      ? "Confirm"
      : workflow?.stage === "handed_off"
        ? "Handed off"
        : "Open";
  const workflowCopy = confirmedAppointment
    ? `${new Date(confirmedAppointment.startsAt).toLocaleString()} · ${confirmedAppointment.confirmationCode}`
    : workflow?.stage === "awaiting_confirmation" && workflow.draft?.startsAt
      ? `Proposed ${new Date(workflow.draft.startsAt).toLocaleString()}. Say yes to confirm.`
      : workflow?.stage === "handed_off"
        ? `A human has been asked to follow up${workflow.handoffReason ? `: ${workflow.handoffReason}` : "."}`
        : "Ask to schedule a time, or escalate to a person at any point.";

  const turns = entries.filter((entry) => entry.role !== "error").length;
  const statusLabel =
    muted && status === "speaking" ? "Responding" : STATUS_LABEL[status];

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
          {realtimeAvailable ? (
            <button
              type="button"
              className={`btn${liveMode ? " is-live" : ""}`}
              onClick={toggleLive}
              disabled={busy && !liveMode}
              aria-pressed={liveMode}
            >
              {liveMode ? "End live" : "Live voice"}
            </button>
          ) : null}
          <span
            className={`status status-${status}`}
            role="status"
            aria-live="polite"
          >
            <i aria-hidden="true" />
            {statusLabel}
          </span>
          <button
            type="button"
            className="btn"
            onClick={() => void resetConversation()}
            disabled={entries.length === 0 && !busy}
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
                  Voxen listens, reasons, and answers as it speaks.
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
            {audio.isPlaying ? (
              <div className="now-playing">
                <WaveBars active />
                <span>Speaking the reply…</span>
                <button
                  type="button"
                  className="link"
                  onClick={stopSpeaking}
                >
                  Stop
                </button>
              </div>
            ) : audio.playbackBlocked && audio.lastAudio ? (
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
                className={`mic${recorder.recording ? " is-recording" : ""}`}
                onClick={toggleRecording}
                disabled={!recorder.micSupported || liveMode}
                aria-label={
                  liveMode
                    ? "Live voice uses the microphone continuously"
                    : recorder.recording
                      ? "Stop recording"
                      : "Start recording"
                }
                title={
                  liveMode
                    ? "Live voice uses the microphone continuously"
                    : recorder.micSupported
                      ? recorder.recording
                        ? "Stop and send"
                        : "Start recording"
                      : "Microphone is not supported in this browser"
                }
              >
                {recorder.recording ? (
                  <StopIcon size={18} />
                ) : (
                  <MicIcon size={20} />
                )}
              </button>

              <input
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder={
                  liveMode
                    ? "Type into the live conversation…"
                    : recorder.recording
                      ? `Listening… ${formatTime(recorder.elapsed)}`
                      : "Type a message, or tap the mic to speak"
                }
                aria-label="Message"
                maxLength={MAX_MESSAGE_CHARS}
                disabled={recorder.recording}
                enterKeyHint="send"
                autoComplete="off"
              />

              <button
                type="submit"
                className="send"
                disabled={!draft.trim() || busy || recorder.recording}
                aria-label="Send message"
              >
                <SendIcon size={18} />
              </button>
            </form>

            <div className="composer-meta">
              {liveMode ? (
                <>
                  <span className="hint">
                    Full-duplex live voice · interrupt by speaking · usage is capped per session
                  </span>
                  <button
                    type="button"
                    className="link danger"
                    onClick={() => void stopLive()}
                  >
                    End live
                  </button>
                </>
              ) : recorder.recording ? (
                <div className="recording-meta">
                  <span className="rec-dot" aria-hidden="true" />
                  <span>
                    {formatTime(recorder.elapsed)}{" "}
                    <span className="muted">
                      / {formatTime(MAX_RECORD_SECONDS)}
                    </span>
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
                <>
                  <span className="hint">
                    Tap the mic to talk · Enter to send · Replies play
                    automatically
                  </span>
                  <button
                    type="button"
                    className="link"
                    onClick={toggleMute}
                    aria-pressed={muted}
                  >
                    {muted ? "Sound off" : "Sound on"}
                  </button>
                </>
              )}
            </div>
          </div>
        </main>

        <aside className="rail" aria-label="Session details">
          <section className="card">
            <div className="card-head">
              <h2>Session</h2>
              <span className={`pill pill-${status}`}>{statusLabel}</span>
            </div>
            <dl className="stats">
              <div>
                <dt>Messages</dt>
                <dd>{turns}</dd>
              </div>
              <div>
                <dt>Input</dt>
                <dd>
                  {liveMode
                    ? "Live voice + text"
                    : recorder.micSupported
                      ? "Voice + text"
                      : "Text only"}
                </dd>
              </div>
              <div>
                <dt>ID</dt>
                <dd className="mono">{sessionId.slice(0, 8) || "—"}</dd>
              </div>
            </dl>
          </section>

          <section className="card workflow-card">
            <div className="card-head">
              <h2>Scheduling</h2>
              <span className="pill">{workflowLabel}</span>
            </div>
            <p className="workflow-copy">{workflowCopy}</p>
            {share ? (
              <div className="summary-box">
                <strong>{share.headline}</strong>
                {share.actionItems.length > 0 ? (
                  <ul>
                    {share.actionItems.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                ) : null}
                <a href={share.url} target="_blank" rel="noreferrer">
                  Open shareable transcript
                </a>
              </div>
            ) : null}
            <div className="workflow-actions">
              <button
                type="button"
                className="btn"
                onClick={() => void submitText("I'd like to schedule an appointment.")}
                disabled={busy}
              >
                Schedule
              </button>
              <button
                type="button"
                className="btn"
                onClick={() =>
                  void submitText("I need to speak with a human about this.")
                }
                disabled={busy}
              >
                Human
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => void shareTranscript()}
                disabled={busy}
              >
                Share
              </button>
            </div>
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
                  <p>The answer streams in text and audio.</p>
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
