# Voice Agent — MVP (Next.js + Node.js)

A browser-based **AI voice assistant**: talk into your microphone, see your transcript, get an LLM answer, and hear it spoken back — including web-search tool calling — in a single full-stack **Next.js (React) + TypeScript** app.

> **Phase:** MVP (Milestone 0–6 of `voice_agent_mvp.md`). It works, it's tested, it's deployable.
> The long-term architecture and roadmap described in the [Roadmap](#roadmap) section below are intentionally **not** implemented yet.
> This Next.js app replaces the original Python/FastAPI prototype.

---

## Table of Contents

1. [What it does](#what-it-does)
2. [System architecture](#system-architecture)
3. [Request lifecycle](#request-lifecycle)
4. [Tech stack](#tech-stack)
5. [Key design decisions](#key-design-decisions)
6. [API reference](#api-reference)
7. [Conversation state](#conversation-state)
8. [Frontend behavior](#frontend-behavior)
9. [Error model](#error-model)
10. [Configuration](#configuration)
11. [Local development](#local-development)
12. [Testing](#testing)
13. [Docker](#docker)
14. [Deployment](#deployment)
15. [Security notes](#security-notes)
16. [Performance & latency expectations](#performance--latency-expectations)
17. [Known limitations](#known-limitations)
18. [Roadmap](#roadmap)

---

## What it does

A user can:

1. Open the site and click **Start Talking**.
2. Speak a natural-language request (e.g. *"Search the web and tell me about the latest PostgreSQL release"*).
3. See the transcript, the agent's answer, and hear the answer spoken.
4. Ask follow-ups — the conversation context is preserved.
5. Start a fresh conversation instantly.

The AI pipeline is **push-to-talk → STT → LLM (+ tools) → TTS**, run in a single HTTP request.

---

## System architecture

```
USER
 │  microphone
 ▼
┌────────────────────────────────────┐
│ Next.js App (React frontend + API) │
│                                    │
│ app/components/VoiceAgent.tsx (client component)
│   - MediaRecorder webm/opus push-to-talk
│   - status state machine + chat log
│                                    │
│ app/api/* (route handlers, server) │
│   - chat / voice / reset / health  │
│                                    │
│ lib/                               │
│   ai.ts          OpenAI calls      │
│   conversation.ts session history  │
│   tools.ts       DuckDuckGo search │
│   config.ts / errors.ts / http.ts  │
└──────┬─────────────────────────────┘
       │
       ├──► gpt-4o-mini-transcribe   (OpenAI)   audio → text
       ├──► gpt-4o-mini + tools      (OpenAI)   text → reply (can call search_web)
       │        └─► DuckDuckGo Lite  (cheerio)  query → results
       ├──► gpt-4o-mini-tts          (OpenAI)   text → mp3 (base64 in JSON)
       │
       ▼
  Speaker output in browser
```

**Deployment topology:** one Next.js app serves both the UI and the API — a single deployable unit with no CORS in production.

---

## Request lifecycle

### Voice path

```
MediaRecorder captures webm/opus  (max 60s, auto-stop timer)
        │
        ▼
POST /api/voice  (multipart: audio, session_id, audio_duration)
        │
        ├─ validations: File present, < 10MB, duration ≤ max_audio_seconds
        ▼
STT   gpt-4o-mini-transcribe  →  transcript text          (if empty → NOTHING_HEARD)
        │
        ▼
conversation.append(user, transcript)                      (capped to last 20 msgs)
        │
        ▼
LLM   gpt-4o-mini  (system prompt + history + tool schemas)
        │
        ├─ plain text ────────────┐   → reply text
        └─ tool call ─► search_web()┘   ──► results appended as "tool" message
               │        (≤ 4 rounds)          ──► LLM summarizes ──► reply text
        │
        ▼
conversation.append(assistant, reply)
        │
        ▼
TTS   gpt-4o-mini-tts  →  mp3 bytes  →  base64  (failure degrades to audio=null)
        │
        ▼
200 {"transcript", "reply", "audio", "history"}   → React plays audio, renders chat
```

### Text path (`/api/chat`)

Same pipeline minus audio capture/STT/TTS — used for quick testing without a microphone.

---

## Tech stack

| Layer | Choice | Version tested | Why |
| --- | --- | --- | --- |
| Runtime | Node.js | 22 | LTS; global fetch/FormData/File, `AbortSignal.timeout` |
| Framework | Next.js (App Router) | 16.3 | Full-stack React: one app serves UI + API; statically-exports-friendly; standalone build for Docker |
| UI | React | 19.3 | Standard for Next.js |
| Language | TypeScript | 7 | Strict typing across routes, lib, and tests |
| STT | OpenAI `gpt-4o-mini-transcribe` | openai SDK 7.x | Cheap one-shot transcription; one API key for all AI |
| LLM | OpenAI `gpt-4o-mini` | openai SDK 7.x | Fast, cheap, supports function calling |
| TTS | OpenAI `gpt-4o-mini-tts` (voice `alloy`, mp3) | openai SDK 7.x | Good quality per dollar; single key |
| Web search | DuckDuckGo Lite + `cheerio` | cheerio 1.2 | Zero API key → MVP keeps just one secret |
| Test runner | Vitest | 5.x | Fast, TS-native, asserts route handlers with mocked AI |

Runtime deps in `package.json` are caret-pinned; `package-lock.json` locks the tested set.

---

## Key design decisions

Documented so the *why* survives the *what*.

| # | Decision | Rationale |
| --- | --- | --- |
| 1 | **One full-stack Next.js app**, not a separate API server | React UI + route handlers ship as one artifact. No CORS, one service to deploy (Vercel, Render, or the Docker image). Decision supersedes the original FastAPI design (#1 of the Python MVP). |
| 2 | **Session-keyed conversations in memory** (`Map<session_id, messages[]>` in `lib/conversation.ts`) | Two users never corrupt one shared history; `/api/reset` clears **only** the target session. No DB needed for MVP. |
| 3 | **History is server-owned**, capped at last 20 messages after the system prompt | Client sends only `session_id`; server builds context. The cap bounds token usage instead of letting histories grow unbounded. |
| 4 | **Audio returned as base64 mp3 in JSON** | Frontend stays trivial: `new Audio("data:audio/mpeg;base64,"+b64)`. No signed-URL endpoints, no storage. |
| 5 | **Half-duplex HTTP, not WebSocket streaming** | The MVP prioritizes a *reliable* loop over a *low-latency* one. Streaming (WebSocket/WebRTC) is the explicit next phase — see [Roadmap](#roadmap). Expected round trip ≈ 5–15 s. |
| 6 | **`response_format="text"` on STT** | The SDK overload returns a plain string — least parsing surface. |
| 7 | **LLM tool-calling loop, ≤ 4 rounds (`MAX_TOOL_ROUNDS`)** | The agent can call `search_web`, receive results, and answer. Rounds are bounded so a loop cannot spin forever. Non-function tool calls and unknown tools fail gracefully as structured output, never an exception. |
| 8 | **DuckDuckGo Lite + cheerio inside `tools.ts`** | Keeps the MVP to a single secret (`OPENAI_API_KEY`) and no third-party scraping SDK. The 5-line `runTool` interface is the swap point for Tavily/Bing later. |
| 9 | **TTS failure does not fail the request** | If speech generation fails, the client still gets `reply` text and `audio: null`. Text always wins; speech is best-effort. |
| 10 | **Typed error contract** — every error carries `{error_code, message}` | The frontend shows a stable message; future tooling (monitoring, retries) can branch on `error_code`. |
| 11 | **`output: "standalone"`** | Produces a small self-contained `server.js` for the Docker image — no Node modules at runtime. |
| 12 | **API key lives in env; a fresh OpenAI client is built per call** (`lib/ai.ts::client()`) | The browser never touches `OPENAI_API_KEY`; per-call construction makes mocking and config trivial. |
| 13 | **Frontend single-flight + status state machine** | Controls disable during processing so overlapping uploads can't interleave history; status (`ready → recording → thinking → speaking → error`) drives all UI feedback via React state, not DOM surgery. |

---

## Project structure

```
.
├── app/
│   ├── api/
│   │   ├── chat/route.ts     POST /api/chat
│   │   ├── voice/route.ts    POST /api/voice
│   │   ├── reset/route.ts    POST /api/reset
│   │   └── health/route.ts   GET  /api/health
│   ├── components/VoiceAgent.tsx   client component (recorder + UI)
│   ├── layout.tsx
│   ├── page.tsx
│   └── globals.css
├── lib/
│   ├── ai.ts          STT / LLM tool loop / TTS (OpenAI)
│   ├── tools.ts       search_web (DuckDuckGo Lite) + runTool dispatch
│   ├── conversation.ts  Map-based session history
│   ├── config.ts      env-driven settings
│   ├── errors.ts      AppError + error codes
│   └── http.ts        error → NextResponse mapper
├── tests/             vitest suites (no API key or network needed)
├── next.config.mjs / tsconfig.json / vitest.config.ts
├── Dockerfile / .dockerignore
└── .env.example
```

---

## API reference

### `GET /api/health`

```json
200 {"status": "ok"}
```

### `POST /api/chat`

Text-only turn. A missing `session_id` creates a new one (returned in the response).

```json
// request
{"session_id": "uuid?", "message": "What is a process in Linux?"}

// 200
{
  "session_id": "3f2e…",
  "reply": "A process is a running instance of a program…",
  "history": [{"role": "user", "content": "…"}, {"role": "assistant", "content": "…"}]
}
```

Validation: `EMPTY_MESSAGE` (400) if the message is blank.

### `POST /api/voice`

`multipart/form-data` fields:

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `audio` | file | yes | Any common audio container (browser sends webm/opus); ≤ 10 MB |
| `session_id` | text | no | Omitted ⇒ a new session is created |
| `audio_duration` | number | no | Seconds; fed to the duration guard |

```json
// 200
{
  "session_id": "3f2e…",
  "transcript": "search the web for the latest postgresql release",  // STT output
  "reply": "PostgreSQL's latest release is…",                          // LLM output
  "audio": "<base64 utf-8 encoded mp3>",                                // TTS output; null if TTS failed
  "history": [{"role": "user", "content": "…"}, {"role": "assistant", "content": "…"}]
}
```

Validation (in order): `EMPTY_AUDIO` (400) → `AUDIO_TOO_LARGE` (413) → `AUDIO_TOO_LONG` (413) → `NOTHING_HEARD` (400) when STT returns no text.

### `POST /api/reset`

```json
// request                    // 200
{"session_id": "3f2e…"}        {"status": "ok", "session_id": "3f2e…"}
```

Clears **only** that session's history. `MISSING_SESSION` (400) without `session_id`.

---

## Conversation state

```ts
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

const conversations = new Map<string, ChatMessage[]>();
// "session-id": [
//   { role: "system", content: <SYSTEM_PROMPT> },   // always first
//   { role: "user", content: "…" },
//   { role: "assistant", content: "…" },
//   // … capped at max_history_messages (default 20) + the system prompt
// ]
```

- Lives in-process (`lib/conversation.ts`) — **lost on restart/redeploy**, by design for MVP.
- The system prompt tells the model to respond naturally and concisely, and to use `search_web` for anything after its knowledge cutoff.
- Truncation keeps the newest 20 messages after the system prompt to bound LLM token usage. Tool messages are appended only to the LLM request copy, never the stored history.

---

## Frontend behavior

A single React client component — no build-time static HTML, all interaction via state + refs.

- **Push-to-talk:** click to record → click again, or the recorder **auto-stops at 60 s**.
- **Microphone denied:** shows a message; the app stays usable.
- **Single flight:** all controls disabled from upload until the response finishes or errors.
- **Status states:** `Ready → Recording… → Thinking… → Speaking… → Ready`, plus `Error` on failure.
- **Session persistence:** `session_id` stored in `localStorage` (via `crypto.randomUUID`), so reloads keep the same conversation server-side.
- **Audio playback:** `Audio` element with a `data:audio/mpeg;base64,…` source; plays automatically once the reply renders.
- **Reset:** clears server history via `/api/reset` and empties the chat log locally.

---

## Error model

| HTTP | `error_code` | Meaning |
| --- | --- | --- |
| 400 | `EMPTY_MESSAGE` | `/api/chat` message is blank |
| 400 | `MISSING_SESSION` | `/api/reset` without `session_id` |
| 400 | `EMPTY_AUDIO` | No audio file uploaded or empty file |
| 413 | `AUDIO_TOO_LARGE` | Upload exceeds `MAX_AUDIO_BYTES` (10 MB) |
| 413 | `AUDIO_TOO_LONG` | `audio_duration` exceeds `MAX_AUDIO_SECONDS` (60 s) |
| 400 | `NOTHING_HEARD` | STT returned no speech |
| 502 | `STT_FAILED` | Transcription call failed (bad key, upstream 5xx, timeout, …) |
| 502 | `LLM_FAILED` | Chat-completions or tool-loop failure |
| 500 | `INTERNAL` | Any unexpected handler error |

Error responses carry `{"detail": {"error_code": …, "message": …}}`. **`TTS_FAILED` never surfaces** — TTS exceptions are swallowed and `audio` is returned as `null` (decision #9). Tool-execution errors are returned *as tool output for the LLM*, not as API errors.

---

## Configuration

Next.js auto-loads `.env` from the project root for `dev`, `build`, and `start`. On Render/Vercel, set the variables directly in the dashboard.

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENAI_API_KEY` | *(required)* | Key for all three OpenAI calls. Never in the browser. |
| `STT_MODEL` | `gpt-4o-mini-transcribe` | Transcription model |
| `LLM_MODEL` | `gpt-4o-mini` | Chat model |
| `TTS_MODEL` | `gpt-4o-mini-tts` | Speech synthesis model |
| `TTS_VOICE` | `alloy` | OpenAI voice name |
| `MAX_TOOL_ROUNDS` | `4` | Maximum LLM↔tool iterations per turn |
| `MAX_HISTORY_MESSAGES` | `20` | Conversation cap (after the system prompt) |
| `MAX_AUDIO_BYTES` | `10485760` | 10 MB server-side upload cap |
| `MAX_AUDIO_SECONDS` | `60` | Duration guard fed by the client's `audio_duration` |

See `.env.example` for a template.

---

## Local development

```bash
# 1. Install
npm install

# 2. Configure the OpenAI key — never commit it
cp .env.example .env        # set OPENAI_API_KEY

# 3. Start the dev server (Next.js Turbopack, fast refresh)
npm run dev
```

Open http://localhost:3000

Quick API smoke test without a microphone:

```bash
curl -s http://localhost:3000/api/health
curl -s -X POST http://localhost:3000/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"session_id":"demo","message":"Hi there!"}'
```

---

## Testing

```bash
npm test          # vitest run
npm run typecheck # tsc --noEmit
```

**No API key or network needed** — the tests `vi.mock` the `@/lib/ai` layer (STT/LLM/TTS) and stub `fetch` for web search, then exercise the real route handlers.

Coverage highlights:

- Contract: `/api/health`, `/api/chat`, `/api/voice`, `/api/reset` happy paths.
- **Session isolation:** two sessions hold independent histories; reset clears only the target.
- Conversation cap: `MAX_HISTORY_MESSAGES` truncation is honored.
- Validation: blank message (400), empty audio (400), oversized audio (413), overly long audio (413), blank transcript → `NOTHING_HEARD`.
- Failure mapping: STT exception → `502 STT_FAILED`; TTS exception → `200` with `audio: null`.
- Tool router: DuckDuckGo DOM parsing, query plumbing, unknown-tool and empty-query payloads.

---

## Docker

```bash
docker build -t voice-agent-next .
docker run --rm -p 3000:3000 -e OPENAI_API_KEY=sk-… voice-agent-next
```

The multi-stage build compiles once, then copies **only** the `standalone` output (`server.js` + production static assets) into a `node:22-alpine` runtime — no source, no node_modules, no package lock.

---

## Deployment

### Option A — Vercel

1. Push this repo to GitHub and import it in Vercel.
2. Framework preset: **Next.js** (auto-detected).
3. Add env var **`OPENAI_API_KEY`**.
4. Deploy. Both UI and API ship on one URL.

> Vercel serverless bodies are capped (~4.5 MB); long recordings are better suited to a self-hosted Node host (Option B). Keep clips short if you use Vercel.

### Option B — Render / Fly / any container host

```bash
# Render: New → Web Service → Docker runtime
# Start command:
node server.js          # requires NEXT_FORCE_STANDALONE or the Docker image above
```

Simplest: deploy the **Docker image** (Option B.1). Or run with the Node build runtime:

1. Build command: `npm ci && npm run build`
2. Start command: `node .next/standalone/server.js`
3. Env var: **`OPENAI_API_KEY`**

The standalone server reads `PORT`/`HOSTNAME` from the environment (Render injects `PORT`).

---

## Security notes

- `OPENAI_API_KEY` exists only server-side (env var). It is never sent to the browser and never committed (see `.gitignore`).
- All client input is validated server-side (size, emptiness, duration) — the frontend guards are UX, not the security boundary.
- Tool arguments are JSON-parsed and dispatched by name; unknown tools return an error string and are never executed.
- Prompt-injection surface is **limited but present** — web-search results become tool output the LLM reads. Current mitigations: results are isolated as a `tool`-role message and the system prompt constrains behavior. Hardening is a roadmap item.
- Traffic should be TLS at the platform level (Vercel/Render do this by default).
- There is **no authentication** on the MVP API, by design (documented in `voice_agent_mvp.md`). Do not point it at the public internet with sensitive data until auth exists.

---

## Performance & latency expectations

The MVP is deliberately half-duplex and non-streaming. Expected UX numbers:

| Stage | Typical |
| --- | --- |
| Record | user-controlled (≤ 60 s) |
| Upload | single multipart file |
| STT → transcript | ~1–3 s |
| LLM first token | ~1–4 s (tool path a bit slower) |
| TTS → audio | ~1–2 s |
| **End-to-end** | **≈ 5–15 s** |

The UI visibly signals each stage (`Thinking…`, `Speaking…`) so slow turns don't look frozen. Cutting this latency is exactly what the streaming phase in the [Roadmap](#roadmap) targets.

---

## Known limitations

- **In-memory state:** conversations are lost on restart/redeploy; no multi-instance sharing. Redis is the planned fix.
- **No authentication or rate limiting:** single-tenant demo scope.
- **DuckDuckGo Lite scraping** can be rate-limited or blocked; results are best-effort. The `runTool` interface is the swap point for a commercial search API.
- **Concurrent requests to the same session** are not serialized server-side (the frontend enforces single-flight client-side only).
- **Base64 audio in JSON** grows the payload ~33%; fine under 10 MB of transcription audio, wasteful for long clips.

---

## Roadmap

Follows the [MVP doc](`voice_agent_mvp.md`) toward the distributed design described before this migration:

1. **Streaming** — WebSocket (or OpenAI Realtime), streaming STT/LLM/TTS, partial transcripts.
2. **Persistence** — PostgreSQL (users, sessions, messages, memories) + Redis (session state, rate limiting).
3. **Authentication** — JWT + HTTPS.
4. **WebRTC, VAD, barge-in** — natural interruptions.
5. **Observability** — structured logs, Prometheus/Grafana, latency metrics.
6. **Distributed** — stateless services, pub/sub, connection affinity, horizontal scaling.

First make it work. Then make it fast. Then make it reliable. Then make it scalable.