"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface UseRecorderOptions {
  maxSeconds: number;
  disabled: boolean;
  onStart?: () => void;
  onComplete: (blob: Blob, mime: string, durationSeconds: number) => void;
  onError: (message: string) => void;
}

interface RecordingTurn {
  recorder: MediaRecorder;
  stream: MediaStream;
  chunks: Blob[];
  mime: string;
  startedAt: number;
  durationSeconds: number;
  discard: boolean;
  finalized: boolean;
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

export function useRecorder(options: UseRecorderOptions) {
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [micSupported, setMicSupported] = useState(true);

  const turnRef = useRef<RecordingTurn | null>(null);
  // Invalidates an in-flight getUserMedia() when the user cancels early.
  const requestRef = useRef(0);
  const intervalRef = useRef<number | null>(null);
  const autoStopRef = useRef<number | null>(null);
  const finishRef = useRef<(discard: boolean) => void>(() => {});
  const disabledRef = useRef(options.disabled);
  const onStartRef = useRef(options.onStart);
  const onCompleteRef = useRef(options.onComplete);
  const onErrorRef = useRef(options.onError);

  disabledRef.current = options.disabled;
  onStartRef.current = options.onStart;
  onCompleteRef.current = options.onComplete;
  onErrorRef.current = options.onError;

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

  const releaseTurn = useCallback((turn: RecordingTurn) => {
    // Tracks are stopped only after the recorder has emitted its final
    // `dataavailable` event, otherwise the last chunk can be clipped.
    turn.stream.getTracks().forEach((track) => track.stop());
    if (turnRef.current === turn) turnRef.current = null;
  }, []);

  const finalize = useCallback(
    (turn: RecordingTurn) => {
      if (turn.finalized) return;
      turn.finalized = true;
      clearTimers();
      releaseTurn(turn);

      if (turn.discard) return;

      const blob = new Blob(turn.chunks, { type: turn.mime });
      if (blob.size === 0) {
        onErrorRef.current("No audio was captured. Try again.");
        return;
      }

      onCompleteRef.current(blob, turn.mime, turn.durationSeconds);
    },
    [clearTimers, releaseTurn],
  );

  const finish = useCallback(
    (discard: boolean) => {
      const turn = turnRef.current;
      if (!turn) {
        // Cancel a getUserMedia() call that has not produced a recorder yet.
        requestRef.current += 1;
        return;
      }

      turn.discard = discard;
      turn.durationSeconds = Math.max(
        0,
        (Date.now() - turn.startedAt) / 1000,
      );
      clearTimers();
      setElapsed(0);
      setRecording(false);

      if (turn.recorder.state === "inactive") {
        finalize(turn);
        return;
      }

      // The stop event delivers the last chunk before finalization. The
      // fallback timer only matters if the browser never fires it.
      try {
        turn.recorder.stop();
        autoStopRef.current = window.setTimeout(() => finalize(turn), 2_000);
      } catch {
        finalize(turn);
      }
    },
    [clearTimers, finalize],
  );

  finishRef.current = finish;

  const start = useCallback(async () => {
    if (disabledRef.current || turnRef.current) return;

    const token = requestRef.current + 1;
    requestRef.current = token;
    onStartRef.current?.();

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
      onErrorRef.current(
        "Microphone access was blocked. Allow microphone permission in your browser and try again.",
      );
      return;
    }

    if (token !== requestRef.current) {
      stream.getTracks().forEach((track) => track.stop());
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
      onErrorRef.current("This browser cannot record audio.");
      return;
    }

    const turn: RecordingTurn = {
      recorder,
      stream,
      chunks: [],
      mime: recorder.mimeType || mime || "audio/webm",
      startedAt: Date.now(),
      durationSeconds: 0,
      discard: false,
      finalized: false,
    };
    turnRef.current = turn;

    // Each turn owns its chunks and duration, so a late event from an old
    // recorder can never leak audio into the next recording.
    recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) turn.chunks.push(event.data);
    });
    recorder.addEventListener("stop", () => finalize(turn), { once: true });

    try {
      recorder.start(250);
    } catch {
      turn.discard = true;
      finalize(turn);
      onErrorRef.current("This browser cannot record audio.");
      return;
    }

    setElapsed(0);
    setRecording(true);

    intervalRef.current = window.setInterval(() => {
      setElapsed((Date.now() - turn.startedAt) / 1000);
    }, 200);
    autoStopRef.current = window.setTimeout(
      () => finishRef.current(false),
      options.maxSeconds * 1000,
    );
  }, [finalize, options.maxSeconds]);

  const stop = useCallback(() => finish(false), [finish]);
  const cancel = useCallback(() => finish(true), [finish]);

  useEffect(() => {
    setMicSupported(
      typeof window !== "undefined" &&
        typeof window.MediaRecorder !== "undefined" &&
        Boolean(navigator.mediaDevices?.getUserMedia),
    );
  }, []);

  useEffect(() => {
    return () => {
      requestRef.current += 1;
      clearTimers();
      const turn = turnRef.current;
      if (!turn) return;

      turn.discard = true;
      if (turn.recorder.state !== "inactive") {
        try {
          turn.recorder.stop();
        } catch {
          finalize(turn);
        }
      } else {
        finalize(turn);
      }
    };
  }, [clearTimers, finalize]);

  return { recording, elapsed, micSupported, start, stop, cancel };
}
