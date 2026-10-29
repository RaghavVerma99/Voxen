"use client";

import { useEffect } from "react";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main className="gate">
      <div className="gate-card">
        <h1>Something went wrong</h1>
        <p>
          The interface hit an unexpected error. You can retry without losing
          your browser session.
        </p>
        <button type="button" className="btn primary block" onClick={reset}>
          Try again
        </button>
      </div>
    </main>
  );
}
