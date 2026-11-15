"use client";

import { AlertIcon, CloseIcon, UserIcon, WaveIcon } from "../Icons";

export type EntryRole = "user" | "agent" | "error";

export interface Entry {
  id: string;
  role: EntryRole;
  text: string;
  at: number;
}

export function WaveBars({ active = false }: { active?: boolean }) {
  return (
    <span className={`wave${active ? " is-active" : ""}`} aria-hidden="true">
      {[0, 1, 2, 3, 4].map((index) => (
        <i key={index} />
      ))}
    </span>
  );
}

export function MessageRow({
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

export function TypingRow() {
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
