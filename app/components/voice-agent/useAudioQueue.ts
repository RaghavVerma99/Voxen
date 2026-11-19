"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface AudioChunk {
  index: number;
  audio: string;
}

/**
 * Plays streamed audio chunks strictly in order. Chunks can arrive while an
 * earlier sentence is still speaking; if autoplay is blocked, the queue is
 * preserved so the user can resume it with a gesture.
 */
export function useAudioQueue() {
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackBlocked, setPlaybackBlocked] = useState(false);
  const [lastAudio, setLastAudio] = useState<string | null>(null);

  const queueRef = useRef<AudioChunk[]>([]);
  const nextIndexRef = useRef(0);
  const playingRef = useRef(false);
  const blockedRef = useRef(false);
  const manualStopRef = useRef(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const settleRef = useRef<((ok: boolean) => void) | null>(null);
  const idleResolversRef = useRef<Array<() => void>>([]);

  const settleIdle = useCallback(() => {
    const resolvers = idleResolversRef.current;
    idleResolversRef.current = [];
    for (const resolve of resolvers) resolve();
  }, []);

  const stop = useCallback(() => {
    manualStopRef.current = true;
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      try {
        audio.currentTime = 0;
      } catch {
        // Some browsers reject seeking a detached audio element.
      }
    }

    const settle = settleRef.current;
    settleRef.current = null;
    audioRef.current = null;
    if (settle) settle(false);

    queueRef.current = [];
    nextIndexRef.current = 0;
    playingRef.current = false;
    blockedRef.current = false;
    setIsPlaying(false);
    setPlaybackBlocked(false);
    settleIdle();
  }, [settleIdle]);

  const playOne = useCallback(
    (base64: string): Promise<boolean> =>
      new Promise((resolve) => {
        const audio = new Audio(`data:audio/wav;base64,${base64}`);
        audioRef.current = audio;

        let settled = false;
        const done = (ok: boolean) => {
          if (settled) return;
          settled = true;
          audio.onended = null;
          audio.onerror = null;
          if (audioRef.current === audio) audioRef.current = null;
          resolve(ok);
        };

        settleRef.current = done;
        audio.onended = () => done(true);
        audio.onerror = () => done(false);
        audio.play().catch(() => done(false));
      }),
    [],
  );

  const drain = useCallback(async (): Promise<void> => {
    if (playingRef.current || blockedRef.current) return;

    playingRef.current = true;
    manualStopRef.current = false;
    setIsPlaying(true);

    try {
      while (true) {
        let chunk = queueRef.current.find(
          (item) => item.index === nextIndexRef.current,
        );

        // If a chunk never arrives (for example, a failed synthesis), jump to
        // the next available index instead of stalling the rest of the reply.
        if (!chunk && queueRef.current.length > 0) {
          nextIndexRef.current = Math.min(
            ...queueRef.current.map((item) => item.index),
          );
          chunk = queueRef.current.find(
            (item) => item.index === nextIndexRef.current,
          );
        }

        if (!chunk) break;

        const ok = await playOne(chunk.audio);
        if (!ok) {
          if (!manualStopRef.current) {
            blockedRef.current = true;
            setLastAudio(chunk.audio);
            setPlaybackBlocked(true);
          }
          break;
        }

        queueRef.current = queueRef.current.filter((item) => item !== chunk);
        nextIndexRef.current += 1;
      }
    } finally {
      playingRef.current = false;
      setIsPlaying(false);
      settleIdle();
    }
  }, [playOne, settleIdle]);

  const enqueue = useCallback(
    (index: number, audio: string) => {
      queueRef.current = [...queueRef.current, { index, audio }].sort(
        (left, right) => left.index - right.index,
      );
      if (!blockedRef.current) void drain();
    },
    [drain],
  );

  /** Clears the queue and prepares a fresh turn. */
  const begin = useCallback(() => {
    stop();
    manualStopRef.current = false;
    blockedRef.current = false;
    setPlaybackBlocked(false);
    setLastAudio(null);
  }, [stop]);

  const resume = useCallback((): Promise<void> => {
    manualStopRef.current = false;
    blockedRef.current = false;
    setPlaybackBlocked(false);
    return drain();
  }, [drain]);

  const waitForIdle = useCallback((): Promise<void> => {
    if (!playingRef.current && queueRef.current.length === 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      idleResolversRef.current.push(resolve);
    });
  }, []);

  useEffect(() => stop, [stop]);

  return {
    isPlaying,
    playbackBlocked,
    lastAudio,
    begin,
    enqueue,
    stop,
    resume,
    waitForIdle,
  };
}
