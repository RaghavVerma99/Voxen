# Voxen

Voxen is a single deployable Next.js app for voice and text AI: streamed answers, spoken replies, web search, a narrow appointment workflow, persisted state, usage metering, and opt-in full-duplex Realtime.

> **v1.1.0** — SSE is the production default. Realtime/WebRTC is flag-gated and off by default. Built with Node.js 22+, Next.js 16, React 19, and strict TypeScript.

## Features

- **SSE first:** typed or push-to-talk input, streamed text, sentence-by-sentence audio.
- **Realtime optional:** full-duplex WebRTC with server VAD, barge-in, and guarded tools.
- **Narrow workflow:** appointment scheduling with explicit confirmation, conflicts, cancellation, handoff, summaries, and revocable share links.
- **Resilient narration:** Realtime narrator with legacy Speech failover; `/api/ready` reports the chain.
- **Observable:** turn traces, stage percentiles, guarded metrics, and deterministic offline/live eval gates.
- **Account-aware:** hashed API keys, per-plan quotas, Realtime metering, and admin usage/billing views.
- **Fail-closed:** access gate, rate limits, daily budget, byte caps, session locks, nonce CSP, and hashed session ids.

## Quick start

Install dependencies and create `.env.local`:

```bash
npm ci
printf 'OPENAI_API_KEY=sk-your-key\n' > .env.local
npm run dev
```

PowerShell:

```powershell
[IO.File]::WriteAllText('.env.local', 'OPENAI_API_KEY=sk-your-key')
```

Open <http://localhost:3000>. Smoke test without a microphone:

```bash
curl -s http://localhost:3000/api/health
curl -s http://localhost:3000/api/ready
curl -sN -X POST http://localhost:3000/api/chat/stream \
  -H 'Content-Type: application/json' \
  -d '{"session_id":"demo-session","message":"Hi there!","speak":false}'
```

Add `REALTIME_ENABLED=true`, restart, and select **Live voice** to try the optional transport.

## Design

### SSE cascade (default)

```text
input → guard → STT → streaming LLM + tools → sentence chunker → TTS chain → ordered audio
                         └─ commit history → done → workflow state
```

SSE order: `session → transcript? → delta… → done → workflow? → audio…`. The `workflow` event is additive; text commits before audio drains, so narration failure never loses the answer. One turn runs per session at a time, with heartbeats and `TURN_TIMEOUT_MS`.

### Realtime/WebRTC (opt-in)

The browser requests a short-lived client secret from `/api/realtime/token`, connects directly to OpenAI, and executes advertised tools through `/api/realtime/tool`. Only the final turn is committed via `/api/realtime/turn`; final audio/token usage is reported to `/api/realtime/usage`. Setup failures fall back to SSE. The OpenAI key stays server-side, and the CSP allows Realtime origins only while the flag is on.

## Configuration

All configuration comes from the environment. Next.js loads `.env.local` for `dev`, `build`, and `start`; no secrets are sent to the browser.

### Models and TTS

| Variable | Default | Notes |
| --- | --- | --- |
| `OPENAI_API_KEY` | — | Required. Server-side key for STT, LLM, narration, and Realtime. |
| `STT_MODEL` | `gpt-transcribe` | JSON response; the app reads `.text`. |
| `LLM_MODEL` | `gpt-6-luna` | Chat Completions + tools. |
| `LLM_REASONING_EFFORT` | `none` | Required for tools on `gpt-6-luna`; use `default`, `off`, or empty to omit. |
| `TTS_PROVIDER` | `realtime` | Primary narrator: `realtime` or legacy `speech`. |
| `TTS_FALLBACK_PROVIDER` | `speech` | Second adapter; `none`/`off` stops after the primary. |
| `REALTIME_TTS_MODEL` | `gpt-realtime-2.1-mini` | Realtime narrator model. |
| `REALTIME_TTS_VOICE` | `marin` | Realtime narrator voice. |
| `REALTIME_TTS_INSTRUCTIONS` | see `lib/config.ts` | Narration style. |
| `TTS_MODEL` | `gpt-4o-mini-tts` | Legacy Speech model. |
| `TTS_VOICE` | `alloy` | Legacy Speech voice. |
| `MAX_TOOL_ROUNDS` | `4` | Bounded tool loop. |
| `MAX_REPLY_TOKENS` | `600` | Sent as `max_completion_tokens`. |
| `OPENAI_TIMEOUT_MS` | `30000` | Provider timeout. |
| `OPENAI_MAX_RETRIES` | `2` | Provider retries. |

`/api/ready` reports the effective TTS chain. The legacy Speech API is time-boxed; set `TTS_FALLBACK_PROVIDER=none` after retiring it.

### Search

| Variable | Default | Notes |
| --- | --- | --- |
| `SEARCH_PROVIDER` | `auto` | `auto`, `tavily`, or `duckduckgo`. |
| `TAVILY_API_KEY` | — | Recommended for production. |
| `SEARCH_TIMEOUT_MS` | `8000` | Per-search timeout. |

`auto` uses Tavily when configured, otherwise keyless DuckDuckGo; Tavily failures fall back to DuckDuckGo. Search text is treated as untrusted third-party content.

### Limits and streaming

| Variable | Default | Notes |
| --- | --- | --- |
| `MAX_HISTORY_MESSAGES` | `20` | Messages kept after the system prompt. |
| `SESSION_TTL_MS` | `1800000` | Session inactivity TTL. |
| `MAX_SESSIONS` | `1000` | LRU eviction threshold. |
| `MAX_AUDIO_BYTES` | `4194304` | Decoded audio cap. |
| `MAX_AUDIO_SECONDS` | `60` | Client-reported duration; `audio_duration` is required. |
| `MAX_MESSAGE_CHARS` | `4000` | Text input cap. |
| `MAX_CHAT_REQUEST_BYTES` | `65536` | JSON request cap. |
| `MAX_VOICE_REQUEST_BYTES` | `4718592` | Multipart request cap. |
| `RATE_LIMIT_REQUESTS` | `20` | Per client/account, per route group, per window. |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Rate-limit window. |
| `DAILY_REQUEST_BUDGET` | `1000` | Shared AI request cap per UTC day. |
| `TURN_TIMEOUT_MS` | `90000` | Hard cap for one streamed turn. |
| `SSE_HEARTBEAT_MS` | `15000` | Keep-alive cadence. |

### Access and identity

| Variable | Default | Notes |
| --- | --- | --- |
| `TRUST_PROXY_HOPS` | auto | `1` on Vercel/Render/Fly, otherwise `0`; set explicitly behind other proxies. |
| `ACCESS_CODE` | — | Shared secret sent as `x-access-code`; required in production. |
| `MIN_ACCESS_CODE_LENGTH` | `16` | Production minimum. |
| `REQUIRE_ACCESS_CODE` | `true` | Set `false` only for a deliberately public production deploy. |
| `IDENTITY_SECRET` | — | HMAC secret for API-key hashes; required when identity mode is enabled. |
| `MIN_IDENTITY_SECRET_LENGTH` | `16` | Production minimum. |
| `IDENTITY_REQUIRED` | `false` | Set `true` to reject requests without an API key. |
| `ADMIN_API_KEY` | — | Bootstrap admin key for `/admin` and `/api/admin/*`; also valid when identity is required. |
| `MIN_ADMIN_KEY_LENGTH` | `16` | Production minimum. |
| `APP_VERSION` | `1.1.0` | Reported by `/api/health`. |

Production fails closed when the access gate or required identity secret is missing/short. Identity is opt-in: API keys are `vk_…` bearer tokens, returned once and stored only as HMAC hashes. Plans are `free` (50/day), `pro` (1,000/day), and `enterprise` (20,000/day); meter rates live in `lib/billing.ts`.

### State and workflow

| Variable | Default | Notes |
| --- | --- | --- |
| `STATE_BACKEND` | `memory` | `memory` is per process; `file` shares one atomic document on a mounted volume. |
| `STATE_STORE_PATH` | `.data/voxen-state.json` | State file for the `file` backend. |
| `STATE_LOCK_TIMEOUT_MS` | `5000` | Max wait for the cross-process lock. |
| `STATE_LOCK_STALE_MS` | `10000` | Age at which an abandoned lock may be reclaimed. |
| `WORKFLOW_ENABLED` | `true` | `false` removes scheduling tools and the `workflow` event. |
| `WORKFLOW_STORE_PATH` | `.data/voxen-workflow.json` | Atomic appointment store. |
| `APPOINTMENT_MINUTES` | `30` | Slot length and alignment. |
| `CONFIRMATION_TTL_MS` | `600000` | Lifetime of a prepared appointment. |
| `SHARE_TTL_MS` | `86400000` | Lifetime of a shareable transcript token. |

Slots are future weekdays, 09:00–17:00 UTC. `STATE_BACKEND=file` shares caps on one host; use a Redis/Postgres `StateBackend` across machines. A corrupt state file fails closed.

### Realtime and eval tracing

| Variable | Default | Notes |
| --- | --- | --- |
| `REALTIME_ENABLED` | `false` | Must be exactly `true` to expose the transport. |
| `REALTIME_MODEL` | `gpt-realtime-2.1-mini` | Full-duplex model. |
| `REALTIME_VOICE` | `marin` | Live voice. |
| `REALTIME_INSTRUCTIONS` | see `lib/config.ts` | Server-side session policy. |
| `REALTIME_MAX_SESSIONS` | `3` | Concurrent sessions per session id. |
| `REALTIME_MAX_AUDIO_SECONDS` | `180` | Audio cap per session. |
| `REALTIME_MAX_OUTPUT_TOKENS` | `4000` | Output-token cap per session. |
| `EVAL_TRACE_ENABLED` | `false` | Opt in only on an isolated eval deployment. |
| `EVAL_TRACE_PATH` | `.data/eval-traces.jsonl` | Append-only JSONL trace file. |
| `EVAL_TRACE_MAX_BYTES` | `5242880` | Trims oldest lines above this size. |
| `EVAL_TRACE_MAX_ROWS` | `2000` | Maximum retained traces. |
| `EVAL_TRACE_MAX_ANSWER_CHARS` | `4000` | Assistant answer cap; no prompt text is stored. |

Live traces are sanitized: raw session ids and user text are excluded. Labels come only from `x-eval-case-id`, `x-eval-attempt-id`, and `x-eval-dimension` headers.

## API

All JSON responses set `cache-control: no-store` and `x-request-id`. Guarded routes also return `RateLimit-Limit`, `RateLimit-Remaining`, and `RateLimit-Reset`.

### Conversation

| Route | Request | Response |
| --- | --- | --- |
| `POST /api/chat` | `{ session_id?, message, speak? }` | Blocking `{ session_id, reply, audio, history }`. |
| `POST /api/chat/stream` | Same body | `text/event-stream`. |
| `POST /api/voice` | multipart: `audio`, `session_id`, `audio_duration`, `speak` | Blocking chat response plus `transcript`. |
| `POST /api/voice/stream` | Same multipart fields | `text/event-stream`. |
| `GET /api/history` | `x-session-id` header or `?session_id=` | `{ session_id, history }`. |
| `POST /api/reset` | `{ session_id }` | `{ status: "ok", session_id }`. |

An invalid `audio_duration` fails before STT or budget reservation. Blocking routes exist for clients that cannot consume SSE.

### Workflow, accounts, and Realtime

| Route | Notes |
| --- | --- |
| `GET /api/workflow` | Persisted workflow state, appointments, and stats. |
| `POST /api/workflow/summary` | Deterministic summary plus a share token and URL. |
| `POST /api/workflow/share/revoke` | Owner-only share revocation. |
| `GET /api/transcript/{token}` | Expiring shared transcript; omits the session id. |
| `GET /api/account` | Caller's account, quota, and usage. |
| `GET /api/admin/accounts` | List accounts without key hashes. |
| `POST /api/admin/accounts` | Create an account; returns its one-time `api_key`. |
| `PATCH /api/admin/accounts` | Update plan, status, or role. |
| `GET /api/admin/usage` | Usage rows and totals. |
| `GET /api/admin/billing` | Invoice-style plan, request, and Realtime totals. |
| `POST /api/realtime/token` | Short-lived client secret and active tool schemas. |
| `POST /api/realtime/tool` | Guarded execution of advertised tools. |
| `POST /api/realtime/turn` | Commit the final live turn and refresh workflow state. |
| `POST /api/realtime/usage` | Enforce caps, record usage, and release the session. |

Admin routes require `x-admin-key` or an admin-role account. The `/admin` page uses the same routes, keeps the key in `sessionStorage`, and shows generated keys once.

### Observability

| Route | Notes |
| --- | --- |
| `GET /api/health` | Public liveness and flags. `?verify=1` checks the access code; `?detail=1` adds config, budget, sessions, workflow, and TTS chain. |
| `GET /api/ready` | Readiness; fails when AI is missing or production access is misconfigured. |
| `GET /api/metrics` | Guarded counters, stage percentiles, and turn traces; no transcript content. |

### Streaming events

| Event | Payload | Meaning |
| --- | --- | --- |
| `session` | `{ session_id }` | Session resolved or created. |
| `transcript` | `{ transcript }` | Voice routes only: STT result. |
| `delta` | `{ text }` | Incremental model text. |
| `audio` | `{ index, audio }` | Base64 WAV for one sentence; play in index order. |
| `done` | `{ session_id, reply, history, spoken }` | Turn committed; may arrive before remaining audio. |
| `workflow` | `{ workflow, appointments }` | Additive persisted-state refresh after a successful commit. |
| `error` | `{ error_code, message, request_id }` | Failure after the stream opened; turn is not committed. |

Lines beginning with `:` are keep-alives. Failures before the first byte use normal JSON errors.

### Errors

Failures return `{ "detail": { "error_code", "message", "request_id" } }`.

| HTTP | Codes |
| --- | --- |
| 400 | `INVALID_BODY`, `EMPTY_MESSAGE`, `INVALID_SESSION`, `MISSING_SESSION`, `EMPTY_AUDIO`, `INVALID_AUDIO_DURATION`, `NOTHING_HEARD`, `INVALID_NAME`, `INVALID_PLAN`, `INVALID_ROLE`, `INVALID_STATUS` |
| 401 | `ACCESS_DENIED`, `AUTH_REQUIRED`, `AUTH_INVALID` |
| 403 | `ADMIN_REQUIRED` |
| 404 | `NOT_FOUND`, `ACCOUNT_NOT_FOUND` |
| 413 | `PAYLOAD_TOO_LARGE`, `MESSAGE_TOO_LONG`, `AUDIO_TOO_LARGE`, `AUDIO_TOO_LONG` |
| 429 | `RATE_LIMITED`, `BUDGET_EXHAUSTED`, `QUOTA_EXHAUSTED` |
| 500 | `INTERNAL` |
| 502 | `STT_FAILED`, `LLM_FAILED`, `TTS_FAILED`, `REALTIME_FAILED` |
| 503 | `CONFIG_ERROR` (access gate, identity secret, or Realtime disabled) |

Open streams report `TURN_TIMEOUT` in an `error` event. Production 5xx messages are generic.

## Security and cost controls

- Guard order: **rate limit → identity → production gate → access code → budget/quota**.
- Secrets stay server-side; Realtime browsers receive only an ephemeral secret.
- Access codes and API keys are constant-time compared; API keys are HMAC-hashed and disabled keys are rejected immediately.
- Requests are rate-limited by account id or trusted client address; quota and budget reservations are atomic.
- Body bytes, audio duration, turns, history, telemetry, and tracked Realtime sessions are bounded.
- Session ids and share tokens are bearer secrets; logs hash session ids and payloads omit them.
- Realtime tools are allowlisted and use the server-owned session id; only the final response is committed.
- Appointment confirmations use hashed, expiring, single-use tokens with audit fields.
- Nonce-based CSP, production HSTS, strict frame/origin policies, and Realtime origins only under the flag.
- Failed turns refund their reservation; client aborts intentionally keep it.
- Errors expose stable codes and request ids without stack traces.

## Development

```bash
npm run check          # typecheck + 185 unit tests
npm test               # Vitest, no network or API key
npm run test:e2e       # Playwright browser E2E (8 scenarios)
npm run test:e2e:install
npm run audit          # production dependency audit
npm run build          # standalone Next.js build
npm run eval           # offline eval dataset
npm run eval:gate      # thresholds + committed-baseline check
npm run eval:live      # score labeled live traces
npm run eval:baseline  # regenerate evals/baseline.json
```

Unit tests need no API key or network. Playwright mocks the OpenAI/app routes and runs the real browser client on port 3100 with a placeholder key, Realtime enabled, and access codes disabled. CI runs `npm ci`, `npm run audit`, typecheck, unit tests, `npm run eval:gate`, build, and Playwright. On Windows PowerShell, use `npm.cmd`.

The bundled offline eval reports **pass@1=55%, pass@5=100%**. `eval:gate` enforces `evals/thresholds.json` and `evals/baseline.json`; regenerate the baseline only after an intentional quality change.

## Deployment

```bash
# Node
npm ci
npm run build
npm start

# Docker
docker build -t voxen .
docker run --env-file .env.local -p 3000:3000 voxen
```

Set production secrets before starting, especially `OPENAI_API_KEY` and either a long `ACCESS_CODE` or `REQUIRE_ACCESS_CODE=false`. Mount a writable volume for `/data` (uid 1001), and set `WORKFLOW_STORE_PATH` and, for local multi-instance caps, `STATE_BACKEND=file` with `STATE_STORE_PATH=/data/voxen-state.json`.

Production checklist:

- Use HTTPS so microphone access and WebRTC are allowed.
- Set `TRUST_PROXY_HOPS` behind a proxy that supplies `X-Forwarded-For`.
- Confirm `/api/ready` reports `ready` and the expected TTS chain.
- Watch `/api/metrics` for p95 latency and provider failures.
- Keep `REALTIME_ENABLED=false` until tested against your browser matrix.
- Use a shared `StateBackend` before scaling across machines.

## Project layout

```text
app/
  api/                 route handlers for conversation, workflow, realtime, admin, and observability
  components/          VoiceAgent, AccessGate, AdminDashboard, voice-agent/*
  admin/page.tsx       operator UI
lib/                   ai, streaming, workflow, state, identity, billing, guard, telemetry, evals
proxy.ts               CSP nonce and document policy
evals/                 dataset, thresholds, and committed baseline
scripts/               eval runner and standalone launcher
tests/ e2e/            Vitest and Playwright suites
Dockerfile next.config.mjs vitest.config.mts playwright.config.ts
.github/workflows/ci.yml
```

## Roadmap

1. Remote shared state: Redis/Postgres `StateBackend` and a shared workflow store.
2. Payment provider integration: checkout, webhooks, and invoice finalization.
3. Workflow depth: rescheduling, reminders, and support handoff records.
4. Realtime hardening: broader browser matrix and measured latency targets.
5. Eval breadth: more labeled live scenarios and provider-specific baselines.
