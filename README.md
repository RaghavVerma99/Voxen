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
  ├─ guard        rate limit → prod access gate → access code → daily budget
  ├─ POST /api/chat/stream    text → SSE (delta, done, audio)
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
  streaming.ts     one streamed turn: mutex → deltas → commit → audio drain
  session-lock.ts  per-session mutex that serializes turns
  sse.ts           SSE framing + sentence chunker
  sse-response.ts  stream lifecycle: heartbeat, deadline, aborts, late errors
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
  byte cap → duration/audio checks → STT → transcript
        │
        ▼
  SSE: session, transcript
        │
        ▼
  session lock → LLM stream ──► delta events ──► sentence chunker ──► TTS queue
        │                                                            │
        ▼                                                            ▼
  commit + done { reply, history, spoken } ────────────────────► audio events
        │
        ▼
  connection closes once the audio queue drains
```

Text is never blocked by speech: `done` is sent and the turn is committed as soon as the model finishes, while sentence audio keeps streaming on the same connection afterwards. If TTS fails, the request still succeeds and `audio` is simply absent. Tool calls run concurrently inside a bounded loop (default 4 rounds).

Turns for one session are serialized, so a retry or a second tab cannot read stale history or commit duplicate messages. SSE comments (`: ping`) keep quiet connections alive, and `TURN_TIMEOUT_MS` aborts a stalled turn so it cannot hold the session lock forever.

---

## Tech stack

| Layer | Choice |
| --- | --- |
| Runtime | Node.js 22+ |
| Framework | Next.js 16 (App Router), React 19 |
| Language | TypeScript (strict) |
| STT | OpenAI `gpt-transcribe` (JSON transcript) |
| LLM | OpenAI `gpt-6-luna` with streaming and function calling |
| TTS | OpenAI Realtime `gpt-realtime-2.1-mini` (speech migration) |
| Search | Tavily (if configured) or keyless DuckDuckGo Lite + cheerio |
| Transport | Server-Sent Events for streaming, JSON for fallbacks |
| Tests | Vitest (route contracts + units, no network) |

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

| Variable | Default | Notes |
| --- | --- | --- |
| `STT_MODEL` | `gpt-transcribe` | JSON transcription; the app reads `.text` |
| `LLM_MODEL` | `gpt-6-luna` | Chat Completions + tools |
| `LLM_REASONING_EFFORT` | `none` | Required for tools on `gpt-6-luna`; set `default`, `off`, or empty to omit the field |
| `TTS_PROVIDER` | `realtime` | `realtime` (default) or `speech` (legacy migration window) |
| `REALTIME_TTS_MODEL` | `gpt-realtime-2.1-mini` | Realtime model used for narration |
| `REALTIME_TTS_VOICE` | `marin` | Realtime voice for narration |
| `REALTIME_TTS_INSTRUCTIONS` | see `lib/config.ts` | Narration instructions for the realtime session |
| `TTS_MODEL` | `gpt-4o-mini-tts` | Legacy Speech API model; only used when `TTS_PROVIDER=speech` |
| `TTS_VOICE` | `alloy` | Voice for the legacy speech path |
| `MAX_TOOL_ROUNDS` | `4` | |
| `MAX_REPLY_TOKENS` | `600` | Sent as `max_completion_tokens` |
| `OPENAI_TIMEOUT_MS` | `30000` | |
| `OPENAI_MAX_RETRIES` | `2` | |

`gpt-6-luna` supports Chat Completions function calling only with `reasoning_effort: "none"`, which is why reasoning is disabled by default. If you swap in another model, either leave `LLM_REASONING_EFFORT` empty to omit the parameter or set an effort that model accepts.

> **Model lifecycle:** the Speech API models (`gpt-4o-mini-tts`, `tts-1`, `tts-1-hd`) shut down on **January 6, 2027**. OpenAI has no drop-in `/v1/audio/speech` replacement; the migration target is `gpt-realtime-2.1-mini` over the Realtime API, which is a different transport and workflow. Voxen now narrates through the Realtime API by default (`TTS_PROVIDER=realtime`): each sentence opens a Realtime session, sends the text as an input message, streams base64 PCM audio back, and returns it wrapped in a WAV container. The legacy Speech API path stays available behind `TTS_PROVIDER=speech` during the migration window. If you override the defaults, note that `gpt-4o-mini` shuts down on **January 14, 2027** and `gpt-4o-mini-transcribe` on **February 26, 2027**.

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
| `MAX_AUDIO_SECONDS` | `60` | Client-reported length; `audio_duration` is required |
| `MAX_MESSAGE_CHARS` | `4000` | Text input cap |
| `MAX_CHAT_REQUEST_BYTES` | `65536` | JSON request cap |
| `MAX_VOICE_REQUEST_BYTES` | `4718592` | Multipart request cap (audio + overhead) |
| `RATE_LIMIT_REQUESTS` | `20` | Per client, per route, per window |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Window length |
| `DAILY_REQUEST_BUDGET` | `1000` | Process-wide AI request cap per UTC day |
| `TURN_TIMEOUT_MS` | `90000` | Hard cap for one streamed turn |
| `SSE_HEARTBEAT_MS` | `15000` | Keep-alive comment cadence |

### Proxy, access, metadata

| Variable | Default | Notes |
| --- | --- | --- |
| `TRUST_PROXY_HOPS` | auto | Trusted proxies in front of the app. Defaults to `1` only when the Vercel/Render/Fly markers are present, otherwise `0`. |
| `ACCESS_CODE` | — | Shared secret sent as `x-access-code`; the UI shows a gate. **Required in production.** |
| `MIN_ACCESS_CODE_LENGTH` | `16` | Minimum accepted access-code length in production |
| `REQUIRE_ACCESS_CODE` | `true` | Set to `false` to deliberately allow a public production deploy |
| `APP_VERSION` | `1.1.0` | Reported by `/api/health` |

In production (`NODE_ENV=production`), the API **fails closed** when the access gate is missing or weak: guarded routes return `503 CONFIG_ERROR`, and `/api/ready` reports `access_code_not_configured`. Development and test are unaffected. Set `REQUIRE_ACCESS_CODE=false` only when you intend to run without a gate.

`TRUST_PROXY_HOPS=0` means `X-Forwarded-For` is ignored and every direct client shares one rate-limit bucket. Auto-detection covers Vercel, Render, and Fly only. On Railway or behind nginx/a load balancer, set the real hop count explicitly; otherwise all clients look like one address.

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

Readiness probe. Returns `503 { "status": "not_ready", "reason": "ai_not_configured" }` when `OPENAI_API_KEY` is missing, and `503 { "status": "not_ready", "reason": "access_code_not_configured" }` when production lacks a valid access gate. Returns `200 { "status": "ready" }` otherwise.

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

`multipart/form-data`: `audio` (file, required), `session_id`, `audio_duration` (**required**, finite non-negative seconds), `speak` (`"true"`/`"false"`). Returns the same shape as `/api/chat` plus `transcript`. A missing or invalid duration returns `400 INVALID_AUDIO_DURATION` before STT runs or budget is reserved.

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
| `done` | `{ session_id, reply, history, spoken }` | Turn committed; may arrive before the remaining `audio` events |
| `error` | `{ error_code, message, request_id }` | Failure after the stream opened |

Events arrive as `session → transcript? → delta… → done → audio…`. Speech continues after `done`, so the turn is durable even if playback is interrupted. Lines beginning with `:` are keep-alive comments, not events.

Failures before the first byte use normal JSON error responses. Failures after streaming starts arrive as an `error` event and the turn is **not** committed to history. A turn that exceeds `TURN_TIMEOUT_MS` ends with `error_code: "TURN_TIMEOUT"` (aborted, not committed).

Streaming routes synthesize speech by default. Pass `"speak": false` (JSON) or `speak=false` (multipart) for a silent stream.

### Errors

Failures return `{ "detail": { "error_code", "message", "request_id" } }`.

| HTTP | Codes |
| --- | --- |
| 400 | `INVALID_BODY`, `EMPTY_MESSAGE`, `INVALID_SESSION`, `MISSING_SESSION`, `EMPTY_AUDIO`, `INVALID_AUDIO_DURATION`, `NOTHING_HEARD` |
| 401 | `ACCESS_DENIED` |
| 413 | `PAYLOAD_TOO_LARGE`, `MESSAGE_TOO_LONG`, `AUDIO_TOO_LARGE`, `AUDIO_TOO_LONG` |
| 429 | `RATE_LIMITED`, `BUDGET_EXHAUSTED` |
| 500 | `CONFIG_ERROR`, `INTERNAL` |
| 502 | `STT_FAILED`, `LLM_FAILED` |
| 503 | `CONFIG_ERROR` (production access gate missing or too short) |

An open stream reports `TURN_TIMEOUT` in its `error` event rather than as an HTTP status. In production, 5xx messages are replaced with a generic string so upstream details are not leaked.

---

## Security and cost controls

- `OPENAI_API_KEY` is server-only; no secret is sent to the browser.
- Guards run in the safe order: **rate limit → production access gate → access code → daily budget**. A production deploy without a valid `ACCESS_CODE` fails closed before any paid work starts. Failed access-code attempts are counted, so the code cannot be brute-forced without a bound. Comparison is timing-safe.
- Budget reservations are **refunded** when a turn fails before producing a useful result: STT errors, empty transcripts, and model failures release their reservation. Junk audio therefore cannot exhaust the daily cap. Client-aborted streams still count, since provider work may already have been billed.
- Client addresses come from `X-Forwarded-For` only when `TRUST_PROXY_HOPS` is set; otherwise the header is ignored to prevent spoofing.
- Request bodies are byte-capped **before** JSON or multipart parsing. Audio is additionally checked for size and for a required, finite duration.
- Turns are serialized per session, so concurrent requests cannot interleave history reads or duplicate commits.
- Streams send keep-alive comments and enforce a hard deadline; a stalled turn is aborted and its lock released.
- Session ids act as bearer tokens: they are validated against a strict URL-safe pattern, sent in headers by the client, and hashed in logs.
- Session state is TTL-expired and LRU-bounded, so public traffic cannot grow memory without limit.
- Document responses carry a strict, nonce-based Content Security Policy plus HSTS in production. API responses are JSON/SSE only.
- Errors expose a stable code and request id without stack traces. 4xx traffic is logged at info/warn; only 5xx is logged as an error.
- The Docker image runs as a non-root user and ships a readiness healthcheck.

**Operational limits:** rate limits, daily budget, sessions, and the session lock are **per process**. That is correct for a single Docker/Render/Fly instance. On multi-instance serverless, move `lib/ratelimit.ts` and `lib/conversation.ts` to shared stores (Redis/Postgres) before relying on them as hard caps.

---

## Testing

```bash
npm run check     # typecheck + tests
npm test          # 73 tests
npm run audit     # production dependency audit
```

Tests need **no API key and no network**. The AI provider is mocked, the tool loop is exercised directly, and `fetch` is stubbed for search. Coverage includes:

- route contracts for blocking and streaming chat/voice
- SSE event order (`done` before audio), audio chunking, and error-after-stream behavior
- keep-alive heartbeats and `TURN_TIMEOUT` deadlines
- atomic turns, per-session serialization, and session isolation
- production access-gate fail-closed behavior and readiness reporting
- budget refunds for failed turns and required recording duration
- access-code rate limiting and proxy trust
- request-size and message/audio limits
- history trimming and session validation
- model request shape (`max_completion_tokens`, `reasoning_effort`, JSON transcripts)
- provider switching, tool-loop bounds, and failure mapping

CI runs typecheck, tests, and a production build on every push and PR (`.github/workflows/ci.yml`).

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
  http.ts logger.ts ratelimit.ts session-lock.ts sse.ts sse-response.ts
  streaming.ts tools.ts validate.ts
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
- **Text wins, speech is best-effort.** The turn commits and `done` is sent before the audio queue drains; TTS failures degrade silently to a text answer.
- **Sentence-level TTS.** Speech starts before the full answer exists, while an index-based queue keeps chunks in order and recovers from blocked autoplay.
- **Serialized turns.** One turn per session at a time prevents stale history reads and duplicate commits.
- **Fail closed.** Production refuses paid traffic unless a real access gate is configured.
- **Bounded everything.** Request bytes, message length, audio size, tool rounds, history, sessions, stream lifetime, and daily spend all have explicit caps, and failed turns return their budget reservation.
- **SSE over half-duplex HTTP.** It delivers low-complexity streaming without a WebSocket server. Full-duplex conversation (VAD, barge-in, sub-second turns) needs WebRTC or the OpenAI Realtime API.

---

## Roadmap

1. **Full-duplex voice** — Realtime API or WebRTC with voice activity detection, barge-in, and <1.5 s to first audio.
2. **Shared state** — Postgres for users/sessions/messages; Redis for sessions, rate limits, and budget.
3. **Identity and billing** — real accounts, per-user quotas, Stripe metering.
4. **Observability and evals** — model traces, latency/cost dashboards, an eval harness for answer quality and tool use.
5. **Product layer** — scenario packs, scoring, reports, and shareable sessions.

> First make it work. Then make it fast. Then make it reliable. Then make it scalable.
