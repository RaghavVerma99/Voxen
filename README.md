# Voxen

A browser-based **AI voice agent**: speak or type, watch the answer stream in, and hear it spoken sentence by sentence — with web search and session memory. One deployable Next.js app, no separate backend.

> **Status:** v1.1 — streaming voice loop, security hardening, and production controls are in place. See [Roadmap](#roadmap) for what comes next.

---

## What it does

1. Tap the mic, speak naturally, and tap stop (60-second cap).
2. The server transcribes the audio, streams the model's answer, and calls a web-search tool when freshness matters.
3. Text appears token by token. Completed sentences are synthesized and played in order while the rest of the answer is still being written.
4. Follow-up questions keep context. A text composer is always available.
5. Start a new session at any time for a clean slate.

Pipeline: **push-to-talk → STT → streaming LLM (+ tools) → sentence-level TTS → ordered playback**.

---

## Architecture

```
Browser
  ├─ MediaRecorder (webm/opus, mp4 on Safari)
  ├─ SSE reader: text deltas + audio chunks
  ├─ ordered audio queue with autoplay fallback
  └─ text composer + session history hydration
        │
        ▼
proxy.ts ── per-request CSP nonce for document routes
        │
        ▼
Next.js route handlers (Node runtime)
  ├─ guard        rate limit → access code → daily budget
  ├─ POST /api/chat/stream    text → SSE (delta, audio, done)
  ├─ POST /api/voice/stream   audio → STT → SSE (transcript, delta, audio)
  ├─ POST /api/chat           blocking JSON fallback
  ├─ POST /api/voice          blocking JSON fallback
  ├─ GET  /api/history        hydrate a session
  ├─ POST /api/reset          clear a session
  ├─ GET  /api/health         liveness (+ opt-in detail)
  └─ GET  /api/ready          readiness for orchestrators
        │
        ▼
lib/
  ai.ts            pooled OpenAI client: STT / LLM stream + tool loop / TTS
  streaming.ts     one streamed turn: deltas → sentence queue → commit
  sse.ts           SSE framing + sentence chunker
  sse-response.ts  stream lifecycle, aborts, late errors
  body.ts          byte-capped JSON and multipart parsing
  tools.ts         search_web (Tavily, keyless DuckDuckGo fallback)
  conversation.ts  TTL + LRU-bounded in-memory sessions
  guard.ts         client identity, rate limiting, access control, budget
  config.ts        env-driven settings
  logger.ts        structured JSON logs + session-id redaction
  http.ts          typed error → response mapping
```

### Streamed turn

```
POST /api/voice/stream (multipart audio)
        │
        ▼
  byte cap → audio checks → STT → transcript
        │
        ▼
  SSE: session, transcript
        │
        ▼
  LLM stream ──► delta events ──► sentence chunker ──► TTS queue
        │                                              │
        │                                              ▼
        │                                        audio events
        ▼
  turn committed after the model finishes
        │
        ▼
  SSE: done { reply, history, spoken }
```

Text is never blocked by speech: if TTS fails, the request still succeeds and `audio` is simply absent. Tool calls run concurrently inside a bounded loop (default 4 rounds).

---

## Tech stack

| Layer | Choice |
| --- | --- |
| Runtime | Node.js 22+ |
| Framework | Next.js 16 (App Router), React 19 |
| Language | TypeScript (strict) |
| STT | OpenAI `gpt-4o-mini-transcribe` |
| LLM | OpenAI `gpt-4o-mini` with streaming and function calling |
| TTS | OpenAI `gpt-4o-mini-tts` |
| Search | Tavily (if configured) or keyless DuckDuckGo Lite + cheerio |
| Transport | Server-Sent Events for streaming, JSON for fallbacks |
| Tests | Vitest (route contracts + units, no network) |
| Deploy | Docker (`output: "standalone"`), Render/Fly, or Vercel |

---

## Quick start

```bash
npm ci
cp .env.example .env        # set OPENAI_API_KEY
npm run dev                 # http://localhost:3000
```

Smoke test without a microphone:

```bash
curl -s http://localhost:3000/api/health
curl -s http://localhost:3000/api/ready
curl -sN -X POST http://localhost:3000/api/chat/stream \
  -H 'Content-Type: application/json' \
  -d '{"session_id":"demo-session","message":"Hi there!","speak":false}'
```

---

## Configuration

Next.js loads `.env` automatically for `dev`, `build`, and `start`. On a host, set variables in the dashboard.

### Required

| Variable | Purpose |
| --- | --- |
| `OPENAI_API_KEY` | One server-side key for STT, LLM, and TTS. Never exposed to the browser. |

### Models

| Variable | Default |
| --- | --- |
| `STT_MODEL` | `gpt-4o-mini-transcribe` |
| `LLM_MODEL` | `gpt-4o-mini` |
| `TTS_MODEL` | `gpt-4o-mini-tts` |
| `TTS_VOICE` | `alloy` |
| `MAX_TOOL_ROUNDS` | `4` |
| `MAX_REPLY_TOKENS` | `600` |
| `OPENAI_TIMEOUT_MS` | `30000` |
| `OPENAI_MAX_RETRIES` | `2` |

### Search

| Variable | Default | Notes |
| --- | --- | --- |
| `SEARCH_PROVIDER` | `auto` | `auto`, `tavily`, or `duckduckgo` |
| `TAVILY_API_KEY` | — | Recommended for production |
| `SEARCH_TIMEOUT_MS` | `8000` | Per-search timeout |

With `auto`, Tavily is used when `TAVILY_API_KEY` is set; otherwise the keyless DuckDuckGo scraper is used. Tavily failures fall back to DuckDuckGo.

### State and limits

| Variable | Default | Notes |
| --- | --- | --- |
| `MAX_HISTORY_MESSAGES` | `20` | Messages kept after the system prompt |
| `SESSION_TTL_MS` | `1800000` | 30 minutes of inactivity |
| `MAX_SESSIONS` | `1000` | LRU eviction beyond this |
| `MAX_AUDIO_BYTES` | `4194304` | 4 MB audio cap |
| `MAX_AUDIO_SECONDS` | `60` | Client-reported recording length |
| `MAX_MESSAGE_CHARS` | `4000` | Text input cap |
| `MAX_CHAT_REQUEST_BYTES` | `65536` | JSON request cap |
| `MAX_VOICE_REQUEST_BYTES` | `4718592` | Multipart request cap (audio + overhead) |
| `RATE_LIMIT_REQUESTS` | `20` | Per client, per route, per window |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Window length |
| `DAILY_REQUEST_BUDGET` | `1000` | Process-wide AI request cap per UTC day |

### Proxy, preview, metadata

| Variable | Default | Notes |
| --- | --- | --- |
| `TRUST_PROXY_HOPS` | auto | Number of trusted proxies in front of the app. Defaults to `1` on Vercel/Render/Fly, otherwise `0`. |
| `ACCESS_CODE` | — | When set, API routes require `x-access-code`; the UI shows a gate. |
| `APP_VERSION` | `1.1.0` | Reported by `/api/health` |

`TRUST_PROXY_HOPS=0` means `X-Forwarded-For` is ignored and every direct client shares one rate-limit bucket. Set it when running behind a known proxy (nginx, a load balancer, or a platform that overwrites the header).

---

## API

All JSON responses set `cache-control: no-store` and `x-request-id`. Guarded routes also return `RateLimit-Limit`, `RateLimit-Remaining`, and `RateLimit-Reset`.

### `GET /api/health`

Public liveness probe. `?verify=1` validates an access code. `?detail=1` adds configuration, budget, and session counts; both query modes are guarded.

```json
{
  "status": "ok",
  "name": "Voxen",
  "version": "1.1.0",
  "uptime_seconds": 42,
  "access_required": false
}
```

### `GET /api/ready`

Readiness probe. Returns `503 { "status": "not_ready" }` when `OPENAI_API_KEY` is missing, `200 { "status": "ready" }` otherwise.

### `POST /api/chat`

Blocking JSON fallback.

```json
// request
{ "session_id": "uuid?", "message": "What is a process?", "speak": true }

// 200
{
  "session_id": "uuid",
  "reply": "A process is a running instance of a program…",
  "audio": "<base64 mp3> | null",
  "history": [{ "role": "user", "content": "…" }]
}
```

### `POST /api/chat/stream`

Same request body; responds with `text/event-stream`.

### `POST /api/voice`

`multipart/form-data`: `audio` (file, required), `session_id`, `audio_duration` (seconds), `speak` (`"true"`/`"false"`). Returns the same shape as `/api/chat` plus `transcript`.

### `POST /api/voice/stream`

Same multipart fields; responds with `text/event-stream`.

### `GET /api/history`

Send the session id as an `x-session-id` header (or `?session_id=…` for curl). Returns `{ "session_id": "…", "history": [...] }`.

### `POST /api/reset`

```json
{ "session_id": "uuid" }   →   { "status": "ok", "session_id": "uuid" }
```

### Streaming events

| Event | Payload | Meaning |
| --- | --- | --- |
| `session` | `{ session_id }` | Session resolved (or created) |
| `transcript` | `{ transcript }` | Voice routes only: STT result |
| `delta` | `{ text }` | Incremental model text |
| `audio` | `{ index, audio }` | Base64 MP3 for one sentence; play in index order |
| `done` | `{ session_id, reply, history, spoken }` | Turn committed |
| `error` | `{ error_code, message, request_id }` | Failure after the stream opened |

Failures before the first byte use normal JSON error responses. Failures after streaming starts arrive as an `error` event and the turn is **not** committed to history.

Streaming routes synthesize speech by default. Pass `"speak": false` (JSON) or `speak=false` (multipart) for a silent stream.

### Errors

Failures return `{ "detail": { "error_code", "message", "request_id" } }`.

| HTTP | Codes |
| --- | --- |
| 400 | `INVALID_BODY`, `EMPTY_MESSAGE`, `INVALID_SESSION`, `MISSING_SESSION`, `EMPTY_AUDIO`, `NOTHING_HEARD` |
| 401 | `ACCESS_DENIED` |
| 413 | `PAYLOAD_TOO_LARGE`, `MESSAGE_TOO_LONG`, `AUDIO_TOO_LARGE`, `AUDIO_TOO_LONG` |
| 429 | `RATE_LIMITED`, `BUDGET_EXHAUSTED` |
| 500 | `CONFIG_ERROR`, `INTERNAL` |
| 502 | `STT_FAILED`, `LLM_FAILED` |

In production, 5xx messages are replaced with a generic string so upstream details are not leaked.

---

## Security and cost controls

- `OPENAI_API_KEY` is server-only; no secret is sent to the browser.
- Guards run in the safe order: **rate limit → access code → daily budget**. Failed access-code attempts are counted, so the code cannot be brute-forced without a bound. Comparison is timing-safe.
- Client addresses come from `X-Forwarded-For` only when `TRUST_PROXY_HOPS` is set; otherwise the header is ignored to prevent spoofing.
- Request bodies are byte-capped **before** JSON or multipart parsing. Audio is additionally checked for size and duration.
- Session ids act as bearer tokens: they are validated against a strict URL-safe pattern, sent in headers by the client, and hashed in logs.
- Session state is TTL-expired and LRU-bounded, so public traffic cannot grow memory without limit.
- Document responses carry a strict, nonce-based Content Security Policy plus HSTS in production. API responses are JSON/SSE only.
- Errors expose a stable code and request id without stack traces.
- The Docker image runs as a non-root user and ships a readiness healthcheck.

**Operational limits:** rate limits, daily budget, and sessions are **per process**. That is correct for a single Docker/Render/Fly instance. On multi-instance serverless, move `lib/ratelimit.ts` and `lib/conversation.ts` to shared stores (Redis/Postgres) before relying on them as hard caps.

---

## Testing

```bash
npm run check     # typecheck + tests
npm test          # 61 tests
npm run audit     # production dependency audit
```

Tests need **no API key and no network**. The AI provider is mocked, the tool loop is exercised directly, and `fetch` is stubbed for search. Coverage includes:

- route contracts for blocking and streaming chat/voice
- SSE event order, audio chunking, and error-after-stream behavior
- atomic turns and session isolation
- access-code rate limiting and proxy trust
- request-size and message/audio limits
- history trimming and session validation
- provider switching, tool-loop bounds, and failure mapping

CI runs typecheck, tests, and a production build on every push and PR (`.github/workflows/ci.yml`).

---

## Deployment

### Docker (recommended)

```bash
docker build -t voxen .
docker run --rm -p 3000:3000 \
  -e OPENAI_API_KEY=sk-… \
  -e TAVILY_API_KEY=tvly-… \
  voxen
```

The multi-stage build copies only the standalone server output into a non-root `node:22-alpine` runtime. The container healthcheck calls `/api/ready`.

### Render / Fly / Railway

- Build: `npm ci && npm run build`
- Start: `npm start` (copies static assets, then launches the standalone server)
- Liveness: `/api/health` · Readiness: `/api/ready`
- Set `OPENAI_API_KEY` (and optionally `TAVILY_API_KEY`, `ACCESS_CODE`).
- `TRUST_PROXY_HOPS` defaults to `1` on these platforms; set it explicitly if you add another proxy.

### Vercel

Import the repo, use the Next.js preset, and set the env vars. Note:

- Serverless request bodies are ~4.5 MB; the default audio cap is 4 MB.
- SSE works, but sessions, rate limits, and the daily budget are per instance. Use a shared store before scaling or treating the budget as a hard cap.
- `TRUST_PROXY_HOPS` defaults to `1` on Vercel.

### Public preview

Set `ACCESS_CODE` to something long and random. The UI asks for it once, stores it in `localStorage`, and sends it as `x-access-code`.

---

## Project structure

```
app/
  api/
    chat/route.ts            blocking text turn
    chat/stream/route.ts     streamed text turn (SSE)
    voice/route.ts           blocking audio turn
    voice/stream/route.ts    streamed audio turn (SSE)
    history/route.ts         session hydration
    reset/route.ts           clear a session
    health/route.ts          liveness (+ opt-in detail)
    ready/route.ts           readiness
  components/
    VoiceAgent.tsx           main client UI
    voice-agent/
      stream.ts              SSE parser + API error mapping
      useRecorder.ts         MediaRecorder lifecycle
      useAudioQueue.ts       ordered playback + autoplay recovery
      Messages.tsx           thread rendering
    AccessGate.tsx           optional preview gate
    Icons.tsx                inline SVG icons
  globals.css                design system + layout
  layout.tsx / page.tsx / not-found.tsx / error.tsx / icon.svg
lib/
  ai.ts body.ts config.ts conversation.ts errors.ts guard.ts
  http.ts logger.ts ratelimit.ts sse.ts sse-response.ts streaming.ts
  tools.ts validate.ts
proxy.ts                     CSP nonce + document security policy
tests/
  api.test.ts ai.test.ts streaming.test.ts units.test.ts
scripts/start.mjs            standalone launcher for `npm start`
Dockerfile  next.config.mjs  vitest.config.mts  .github/workflows/ci.yml
```

---

## Design notes

- **One deployable unit.** UI and API ship together; no CORS surface.
- **Server-owned history.** The client sends only a session id; the server is the source of truth.
- **Atomic turns.** A turn is committed only after the model finishes successfully.
- **Text wins, speech is best-effort.** TTS failures degrade silently to a text answer.
- **Sentence-level TTS.** Speech starts before the full answer exists, while an index-based queue keeps chunks in order and recovers from blocked autoplay.
- **Single pooled OpenAI client** with timeouts and retries to protect tail latency.
- **Bounded everything.** Request bytes, message length, audio size, tool rounds, history, sessions, and daily spend all have explicit caps.
- **SSE over half-duplex HTTP.** It delivers low-complexity streaming without a WebSocket server. Full-duplex conversation (VAD, barge-in, sub-second turns) needs WebRTC or the OpenAI Realtime API.

---

## Roadmap

1. **Full-duplex voice** — Realtime API or WebRTC with voice activity detection, barge-in, and <1.5 s to first audio.
2. **Shared state** — Postgres for users/sessions/messages; Redis for sessions, rate limits, and budget.
3. **Identity and billing** — real accounts, per-user quotas, Stripe metering.
4. **Observability and evals** — model traces, latency/cost dashboards, an eval harness for answer quality and tool use.
5. **Product layer** — scenario packs, scoring, reports, and shareable sessions.

> First make it work. Then make it fast. Then make it reliable. Then make it scalable.
