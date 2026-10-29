# Voxen

A browser-based **AI voice agent**: speak (or type), get an intelligent answer, and hear it spoken back — with web search and session memory. Built as a single deployable Next.js app.

> **Status:** deployment-hardened MVP. Voice loop, tool calling, cost controls, rate limiting, and a production UI are in place. See [Roadmap](#roadmap) for what is intentionally still missing.

---

## What it does

1. Tap the mic, speak naturally, and tap stop.
2. The server transcribes the audio, sends it to an LLM, and lets the model call a web-search tool when freshness matters.
3. The answer is returned as text **and** spoken audio, then played automatically.
4. Follow-up questions keep context. A text input is available as a fallback.
5. Start a new session at any time for a clean slate.

Pipeline: **push-to-talk → STT → LLM (+ tools) → TTS**, in one request.

---

## Architecture

```
Browser (Next.js client component)
  ├─ MediaRecorder (webm/opus or mp4 on Safari)
  ├─ push-to-talk + live timer + cancel
  ├─ text fallback
  └─ audio playback with autoplay fallback
        │
        ▼
Next.js route handlers (Node runtime)
  ├─ guard: access code → rate limit → daily budget
  ├─ POST /api/voice   audio → STT → LLM → TTS
  ├─ POST /api/chat    text → LLM → optional TTS
  ├─ POST /api/reset   clear one session
  └─ GET  /api/health  liveness + configuration
        │
        ▼
lib/
  ai.ts            STT / LLM tool loop / TTS (shared, pooled client)
  tools.ts         search_web (Tavily, DuckDuckGo fallback)
  conversation.ts  TTL + LRU-bounded in-memory sessions
  guard.ts         access + rate limit + budget
  ratelimit.ts     fixed-window limiter
  validate.ts      session id validation
  config.ts        env-driven settings
  logger.ts        structured JSON logs
  http.ts          typed error → response mapping
```

### Request lifecycle

```
audio upload ─► size/duration checks ─► STT ─► transcript
                                                   │
                                    build context (system + history + turn)
                                                   │
                                          LLM (+ search_web loop)
                                                   │
                                    commit user + assistant atomically
                                                   │
                                          TTS (best-effort)
                                                   │
                      200 { transcript, reply, audio, history }
```

Tool calls run concurrently, with a bounded number of rounds. A failed turn never leaves a half-written conversation behind.

---

## Tech stack

| Layer | Choice |
| --- | --- |
| Runtime | Node.js 22+ |
| Framework | Next.js 16 (App Router), React 19 |
| Language | TypeScript (strict) |
| STT | OpenAI `gpt-4o-mini-transcribe` |
| LLM | OpenAI `gpt-4o-mini` with function calling |
| TTS | OpenAI `gpt-4o-mini-tts` |
| Search | Tavily (if key set) or keyless DuckDuckGo Lite + cheerio |
| Tests | Vitest (route handlers + units, no network) |
| Deploy | Docker (`output: "standalone"`), Render/Fly, or Vercel |

---

## Quick start

```bash
npm install
cp .env.example .env        # set OPENAI_API_KEY
npm run dev                 # http://localhost:3000
```

Smoke test without a microphone:

```bash
curl -s http://localhost:3000/api/health
curl -s -X POST http://localhost:3000/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"session_id":"demo-session","message":"Hi there!"}'
```

---

## Configuration

Next.js loads `.env` automatically for `dev`, `build`, and `start`. On a host, set these in the dashboard.

### Required

| Variable | Purpose |
| --- | --- |
| `OPENAI_API_KEY` | One key for STT, LLM, and TTS. Server-side only. |

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
| `TAVILY_API_KEY` | — | Recommended for production; enables keyed search |
| `SEARCH_TIMEOUT_MS` | `8000` | Per-search timeout |

With `auto`, Tavily is used when `TAVILY_API_KEY` is present; otherwise the keyless DuckDuckGo scraper is used and Tavily failures fall back to it.

### State & limits

| Variable | Default | Notes |
| --- | --- | --- |
| `MAX_HISTORY_MESSAGES` | `20` | Messages kept after the system prompt |
| `SESSION_TTL_MS` | `1800000` | 30 minutes of inactivity |
| `MAX_SESSIONS` | `1000` | LRU eviction beyond this |
| `MAX_AUDIO_BYTES` | `4194304` | 4 MB (fits Vercel's request limit) |
| `MAX_AUDIO_SECONDS` | `60` | Client-reported duration guard |
| `MAX_MESSAGE_CHARS` | `4000` | Text input cap |
| `RATE_LIMIT_REQUESTS` | `20` | Per client, per route, per window |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Window length |
| `DAILY_REQUEST_BUDGET` | `1000` | Process-wide AI request cap per UTC day |

### Private preview

| Variable | Default | Notes |
| --- | --- | --- |
| `ACCESS_CODE` | — | When set, all API routes require `x-access-code`. The UI shows a gate. |
| `APP_VERSION` | `1.0.0` | Reported by `/api/health` |

---

## API

### `GET /api/health`

Public liveness endpoint. Also supports `?verify=1` with `x-access-code` to validate a stored code.

```json
{
  "status": "ok",
  "name": "Voxen",
  "version": "1.0.0",
  "uptime_seconds": 42,
  "access_required": false,
  "checks": { "ai": "configured", "search": "tavily" },
  "budget": { "date": "2026-10-29", "used": 3, "limit": 1000 },
  "sessions": 1
}
```

### `POST /api/chat`

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

### `POST /api/voice`

`multipart/form-data`: `audio` (file, required), `session_id`, `audio_duration` (seconds).

```json
// 200
{
  "session_id": "uuid",
  "transcript": "search the latest postgres release",
  "reply": "PostgreSQL 18 is…",
  "audio": "<base64 mp3> | null",
  "history": [{ "role": "user", "content": "…" }]
}
```

### `POST /api/reset`

```json
{ "session_id": "uuid" }   →   { "status": "ok", "session_id": "uuid" }
```

### Errors

All failures return `{ "detail": { "error_code", "message", "request_id" } }`.

| HTTP | Codes |
| --- | --- |
| 400 | `EMPTY_MESSAGE`, `INVALID_SESSION`, `MISSING_SESSION`, `EMPTY_AUDIO`, `NOTHING_HEARD` |
| 401 | `ACCESS_DENIED` |
| 413 | `MESSAGE_TOO_LONG`, `AUDIO_TOO_LARGE`, `AUDIO_TOO_LONG` |
| 429 | `RATE_LIMITED`, `BUDGET_EXHAUSTED` |
| 500 | `CONFIG_ERROR`, `INTERNAL` |
| 502 | `STT_FAILED`, `LLM_FAILED` |

TTS failures never fail the request — `audio` is simply `null`. In production, 5xx messages are replaced with a generic string so upstream details are not leaked.

---

## Security & cost controls

- `OPENAI_API_KEY` is server-only and never reaches the browser.
- Every route passes through: **access code (optional) → per-client rate limit → daily spend budget**.
- Session ids are validated against a strict URL-safe pattern.
- Session state is TTL-expired and LRU-bounded, so a public endpoint cannot grow memory forever.
- Client-supplied audio is size- and duration-checked server-side.
- Security headers are set in `next.config.mjs` (`nosniff`, `DENY` framing, referrer policy, microphone-only permissions, COOP).
- Errors expose a stable `error_code` without leaking stack traces or upstream messages in production.
- The Docker image runs as a non-root user and ships a healthcheck.

**Limitations to know:** rate limits and the daily budget are **per process**. That is correct for a single Docker/Render/Fly instance; on multi-instance serverless, replace `lib/ratelimit.ts` with a shared store (Upstash Redis, etc.). Session state is also in-process by design — the next step is Postgres + Redis.

---

## Testing

```bash
npm test          # 38 tests
npm run typecheck
npm run check     # typecheck + tests
```

Tests need **no API key and no network**: the AI provider is mocked, the tool loop is exercised directly, and `fetch` is stubbed for search. Coverage includes contract tests, session isolation, history trimming, atomic turns, validation, access control, rate limiting, provider switching, tool-loop bounds, and failure mapping.

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

The multi-stage build copies only the standalone server output into a non-root `node:22-alpine` runtime.

### Render / Fly / Railway

- Build: `npm ci && npm run build`
- Start: `npm start` (launches the standalone server and copies static assets)
  or `node .next/standalone/server.js`
- Health check path: `/api/health`
- Set `OPENAI_API_KEY` (and optionally `TAVILY_API_KEY`, `ACCESS_CODE`).

### Vercel

Import the repo, use the Next.js preset, and set the env vars. Note:

- Serverless request bodies are ~4.5 MB; the default `MAX_AUDIO_BYTES` is 4 MB.
- In-memory sessions, rate limits, and the daily budget are per instance. Use a shared store before scaling or relying on the budget as a hard cap.

### Public preview

Set `ACCESS_CODE` to something long and random. The UI will ask for it once and store it in `localStorage`; requests send it as `x-access-code`.

---

## Project structure

```
app/
  api/chat|voice|reset|health/route.ts
  components/VoiceAgent.tsx      main client UI
  components/AccessGate.tsx      optional preview gate
  components/Icons.tsx           inline SVG icons
  globals.css                    design system + layout
  layout.tsx / page.tsx / error.tsx / icon.svg
lib/
  ai.ts config.ts conversation.ts errors.ts guard.ts http.ts
  logger.ts ratelimit.ts tools.ts validate.ts
tests/
  api.test.ts units.test.ts
scripts/start.mjs                standalone launcher for `npm start`
Dockerfile  next.config.mjs  vitest.config.mts  .github/workflows/ci.yml
```

---

## Design notes

- **One deployable unit.** UI and API ship together; no CORS.
- **Server-owned history.** The client sends only a session id.
- **Atomic turns.** A turn is committed only after the LLM succeeds.
- **Single pooled OpenAI client** with timeouts and retries, to protect tail latency.
- **Degraded TTS.** Text always wins; speech is best-effort.
- **In-memory state is deliberate** for this stage, and bounded so it cannot leak unboundedly.
- **Half-duplex HTTP** is the current tradeoff. Expected end-to-end latency is ~5–15 s; streaming is the next milestone.

---

## Roadmap

1. **Streaming voice** — WebSocket/WebRTC or the OpenAI Realtime API, VAD, barge-in, <1.5 s to first audio.
2. **Persistence** — Postgres for users/sessions/messages; Redis for shared sessions and rate limits.
3. **Authentication** — real accounts instead of a shared access code.
4. **Billing & quotas** — Stripe, per-user usage metering.
5. **Observability & evals** — LLM traces, latency/cost dashboards, an eval harness for answer quality and tool use.
6. **Product layer** — scenario packs, scoring, reports, shareable sessions (see `voice_agent_mvp.md` for the original scope).

> First make it work. Then make it fast. Then make it reliable. Then make it scalable.

---

`voice_agent_mvp.md` is the original milestone spec (written around a FastAPI prototype) and is kept for historical context. This Next.js implementation supersedes it.
