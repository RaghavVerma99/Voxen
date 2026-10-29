"use client";

import { useState, type FormEvent } from "react";
import { WaveIcon } from "./Icons";

interface AccessGateProps {
  onSubmit: (code: string) => void;
  busy: boolean;
  error: string;
}

export default function AccessGate({ onSubmit, busy, error }: AccessGateProps) {
  const [code, setCode] = useState("");

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = code.trim();
    if (trimmed && !busy) onSubmit(trimmed);
  }

  return (
    <main className="gate">
      <div className="gate-card">
        <span className="brand-mark">
          <WaveIcon size={22} />
        </span>
        <h1>Voxen</h1>
        <p>
          This preview is protected. Enter your access code to start a voice
          session.
        </p>

        <form onSubmit={handleSubmit}>
          <label className="sr-only" htmlFor="access-code">
            Access code
          </label>
          <input
            id="access-code"
            type="password"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            placeholder="Access code"
            autoComplete="current-password"
            autoFocus
            spellCheck={false}
          />
          {error ? (
            <p className="gate-error" role="alert">
              {error}
            </p>
          ) : null}
          <button
            type="submit"
            className="btn primary"
            disabled={!code.trim() || busy}
          >
            {busy ? "Checking…" : "Enter"}
          </button>
        </form>
      </div>
    </main>
  );
}
