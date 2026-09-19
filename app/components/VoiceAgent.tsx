"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Status = "ready" | "recording" | "thinking" | "speaking" | "error";

interface ChatEntry {
  role: "user" | "agent" | "error";
  text: string;
}

interface VoiceResponse {
  session_id: string;
  transcript: string;
  reply: string;
  audio: string | null;
}

const SESSION_KEY = "voice_agent_session_id";
const MAX_RECORD_SECONDS = 60;

function getSessionId(): string {
  if (typeof window === "undefined") return "";
  const existing = window.localStorage.getItem(SESSION_KEY);
  if (existing) return existing;
  const created = window.crypto.randomUUID();
  window.localStorage.setItem(SESSION_KEY, created);
  return created;
}

const STATUS_LABELS: Record<Status, string> = {
  ready: "Ready",
  recording: "Recording…",
  thinking: "Thinking…",
  speaking: "Speaking…",
  error: "Error",
};

export default function VoiceAgent() {
  const [status, setStatus] = useState<Status>("ready");
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);

  const sessionIdRef = useRef<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<number | null>(null);
  const startedAtRef = useRef(0);
  const lastDurationRef = useRef(0);
  const logRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    sessionIdRef.current = getSessionId();
  }, []);

  useEffect(() => {
    const node = logRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [entries]);

  const addEntry = useCallback((entry: ChatEntry) => {
    setEntries((previous) => [...previous, entry]);
  }, []);

  function playAudio(base64Data: string): Promise<void> {
    const audio = new Audio(`data:audio/mpeg;base64,${base64Data}`);
    return new Promise((resolve, reject) => {
      audio.onended = () => resolve();
      audio.onerror = () => reject(new Error("Could not play audio"));
      audio.play().catch(reject);
    });
  }

  async function submitAudio(blob: Blob): Promise<void> {
    setBusy(true);
    setStatus("thinking");
    try {
      const formData = new FormData();
      formData.append("audio", blob, "recording.webm");
      formData.append("session_id", sessionIdRef.current ?? "");
      formData.append("audio_duration", String(lastDurationRef.current));

      const res = await fetch("/api/voice", { method: "POST", body: formData });
      const data = (await res.json().catch(() => ({}))) as Partial<VoiceResponse> & {
        detail?: { message?: string };
      };
      if (!res.ok) {
        throw new Error(data.detail?.message ?? "Request failed");
      }

      addEntry({ role: "user", text: data.transcript ?? "" });
      addEntry({ role: "agent", text: data.reply ?? "" });
      setStatus("speaking");
      if (data.audio) {
        await playAudio(data.audio);
      }
      setStatus("ready");
    } catch (err) {
      setStatus("error");
      addEntry({ role: "error", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  }

  function stopRecording() {
    lastDurationRef.current = (Date.now() - startedAtRef.current) / 1000;
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") recorder.stop();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    setRecording(false);
  }

  async function startRecording() {
    if (busy) return;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setStatus("error");
      addEntry({
        role: "error",
        text: "Microphone access denied. Check browser permissions.",
      });
      return;
    }

    streamRef.current = stream;
    chunksRef.current = [];
    startedAtRef.current = Date.now();
    const recorder = new MediaRecorder(stream);
    recorderRef.current = recorder;

    recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) chunksRef.current.push(event.data);
    });
    recorder.addEventListener("stop", onRecordingStopped);

    recorder.start();
    setRecording(true);
    setStatus("recording");
    timerRef.current = window.setTimeout(stopRecording, MAX_RECORD_SECONDS * 1000);
  }

  async function onRecordingStopped() {
    recorderRef.current = null;
    const blob = new Blob(chunksRef.current, { type: "audio/webm" });
    if (blob.size === 0) {
      setStatus("ready");
      addEntry({ role: "error", text: "No audio captured. Try again." });
      return;
    }
    await submitAudio(blob);
  }

  async function resetConversation() {
    if (busy) return;
    try {
      await fetch("/api/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionIdRef.current ?? "" }),
      });
    } catch {}
    setEntries([]);
    setStatus("ready");
  }

  const toggleRecording = () => {
    if (recording) {
      stopRecording();
    } else {
      void startRecording();
    }
  };

  return (
    <main className="app">
      <header>
        <h1>AI Voice Agent</h1>
        <span className="status" data-state={status}>
          {STATUS_LABELS[status]}
        </span>
      </header>

      <section ref={logRef} className="log" aria-live="polite">
        {entries.length === 0 && (
          <p className="placeholder">Click Start Talking and ask me anything.</p>
        )}
        {entries.map((entry, index) => (
          <div key={index} className={`msg ${entry.role}`}>
            <span className="label">
              {entry.role === "user" ? "You" : entry.role === "error" ? "Error" : "Agent"}
            </span>
            <div>{entry.text}</div>
          </div>
        ))}
      </section>

      <footer className="controls">
        <button
          className="record-btn"
          data-state={recording ? "recording" : ""}
          disabled={busy && !recording}
          onClick={toggleRecording}
          type="button"
        >
          {recording ? "⏹ Stop Talking" : "🎙️ Start Talking"}
        </button>
        <button
          className="reset-btn"
          disabled={busy}
          onClick={() => void resetConversation()}
          type="button"
        >
          New Conversation
        </button>
      </footer>
    </main>
  );
}