const encoder = new TextEncoder();

/** Encodes one Server-Sent Event frame. */
export function encodeSse(event: string, data: unknown): Uint8Array {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/** Encodes an SSE comment, used as a keep-alive while work is in flight. */
export function encodeSseComment(text: string): Uint8Array {
  return encoder.encode(`: ${text}\n\n`);
}

export function sseHeaders(): Record<string, string> {
  return {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  };
}

const SENTENCE_END = /[.!?…](?:["')\]]+)?(?=\s)/g;
const MAX_CHUNK_CHARS = 260;

/**
 * Turns a token stream into speakable chunks. Splitting on sentence
 * boundaries lets the first audio start while the model is still writing;
 * the max-length fallback prevents a long unpunctuated answer from waiting
 * for the end of the turn.
 */
export class SentenceChunker {
  private buffer = "";

  push(text: string): string[] {
    this.buffer += text;
    const chunks: string[] = [];
    let consumed = 0;

    SENTENCE_END.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = SENTENCE_END.exec(this.buffer)) !== null) {
      const end = match.index + match[0].length;
      const chunk = this.buffer.slice(consumed, end).trim();
      if (chunk) chunks.push(chunk);
      consumed = end;
    }

    if (consumed > 0) {
      this.buffer = this.buffer.slice(consumed).replace(/^\s+/, "");
    }

    while (this.buffer.length > MAX_CHUNK_CHARS) {
      const window = this.buffer.slice(0, MAX_CHUNK_CHARS);
      const lastSpace = Math.max(
        window.lastIndexOf(" "),
        window.lastIndexOf("\n"),
      );
      const cut = lastSpace > 80 ? lastSpace : MAX_CHUNK_CHARS;
      const chunk = this.buffer.slice(0, cut).trim();
      if (chunk) chunks.push(chunk);
      this.buffer = this.buffer.slice(cut).replace(/^\s+/, "");
    }

    return chunks;
  }

  flush(): string[] {
    const rest = this.buffer.trim();
    this.buffer = "";
    return rest ? [rest] : [];
  }
}
