"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface UseRecorderOptions {
  maxSeconds: number;
  disabled: boolean;
  onStart?: () => void;
  onComplete: (blob: Blob, mime: string, durationSeconds: number) => void;
  onError: (message: string) => void;
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

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const mimeRef = useRef("audio/webm");
  const startedAtRef = useRef(0);
  const durationRef = useRef(0);
  const discardRef = useRef(false);
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

  const stopStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  const onRecordingStopped = useCallback(() => {
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
      onErrorRef.current("No audio was captured. Try again.");
      return;
    }

    onCompleteRef.current(blob, mime, durationRef.current);
  }, [stopStream]);

  const finish = useCallback(
    (discard: boolean) => {
      const recorder = recorderRef.current;
      durationRef.current = Math.max(
        0,
        (Date.now() - startedAtRef.current) / 1000,
      );
      clearTimers();
      setElapsed(0);
      setRecording(false);
      discardRef.current = discard;

      if (recorder && recorder.state !== "inactive") recorder.stop();
      else recorderRef.current = null;
      stopStream();
    },
    [clearTimers, stopStream],
  );

  finishRef.current = finish;

  const start = useCallback(async () => {
    if (disabledRef.current || recorderRef.current) return;
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
    setRecording(true);

    intervalRef.current = window.setInterval(() => {
      setElapsed((Date.now() - startedAtRef.current) / 1000);
    }, 200);
    autoStopRef.current = window.setTimeout(
      () => finishRef.current(false),
      options.maxSeconds * 1000,
    );
  }, [onRecordingStopped, options.maxSeconds]);

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
      discardRef.current = true;
      clearTimers();
      const recorder = recorderRef.current;
      if (recorder && recorder.state !== "inactive") recorder.stop();
      stopStream();
    };
  }, [clearTimers, stopStream]);

  return { recording, elapsed, micSupported, start, stop, cancel };
}
