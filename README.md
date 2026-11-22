# Voxen

Voxen is a browser-based **AI voice agent** in one deployable Next.js app. Speak or type, watch the reply stream in, and hear it spoken sentence by sentence. It includes web search, bounded session memory, a narrow persisted appointment workflow, turn telemetry, offline and live-trace evals with CI regression gates, and an opt-in full-duplex Realtime/WebRTC transport.

> **Status:** v1.1.0. The default SSE cascade is production-ready for a single instance; the Realtime/WebRTC path is flag-gated and intentionally off by default.

---

## Highlights

- **Two transports.** Default push-to-talk over SSE; optional low-latency full-duplex WebRTC with server VAD and barge-in.
- **Streaming-first.** Text commits before audio drains, so a failed narrator never loses the answer.
- **Durable narrow workflow.** Appointment scheduling with explicit confirmation, conflict detection, cancellation, human handoff, deterministic post-call summary, and tokenized shareable transcripts.
- **TTS failover.** Realtime narrator first, legacy Speech API second; the chain is reported by `/api/ready`.
- **Operational visibility.** Per-turn traces, stage percentiles, guarded `/api/metrics`, and deterministic offline/live eval harnesses with regression gates.
- **Accounts and metering.** Hashed API keys, per-plan daily quotas, Realtime audio/token metering, and admin usage/billing views.
- **Fail-closed controls.** Production access gate, rate limits, daily budget, byte caps, session serialization, CSP nonce, and hashed session ids.

---

## Product loop

### Default SSE cascade

1. Tap the mic, speak, and stop (60-second cap). Or just type.
2. The server transcribes audio with `gpt-transcribe`, then streams `gpt-6-luna` with tools.
3. Search runs only when freshness matters; scheduling tools run when the user asks to book.
4. Completed sentences are synthesized and played in order while the rest of the answer is still being generated.
5. The turn is committed as text first; audio continues on the same SSE connection.
6. A `workflow` event refreshes persisted scheduling state, and the composer stays available for follow-ups.

```text
push-to-talk / text
        │
        ▼
byte cap → guard → STT → streaming LLM + tools
        │                    │
        │                    ├─ delta events → sentence chunker → TTS chain → ordered audio
        │                    └─ commit history → done → workflow state
        ▼
SSE: session → transcript? → delta… → done → workflow? → audio…
```

### Optional Realtime/WebRTC mode

When `REALTIME_ENABLED=true`, the UI shows a **Live voice** button. The browser:

1. Calls `/api/realtime/token`; the server mints a short-lived client secret with OpenAI using the standard key, session policy, input transcription, tool schemas, and `server_vad` with `interrupt_response: true`.
2. Creates an `RTCPeerConnection`, adds the microphone track and an `oai-events` data channel, and posts the SDP offer directly to `https://api.openai.com/v1/realtime/calls` with the ephemeral secret.
3. Receives transcripts, text deltas, audio markers, and function-call events over the data channel while model speech arrives on the media track.
4. Executes allowed function calls through `/api/realtime/tool`; the server owns workflow state and returns the tool output to the data channel before asking the model to continue.
5. Interrupts naturally by speaking; a manual **Stop** sends `response.cancel` plus `input_audio_buffer.clear`.
6. Commits the final live turn through `/api/realtime/turn`, which appends history, refreshes workflow state, and records transport telemetry. Tool-only intermediate responses are not committed.
7. Reports final audio seconds and output tokens to `/api/realtime/usage` when the session ends, releasing the session reservation.
8. Falls back to the standard SSE voice path if any setup step fails.

The OpenAI key never leaves the server. The browser only sees the ephemeral secret, and the CSP allows the Realtime origin only when the flag is on. SSE remains the production default; Realtime is opt-in because it changes browser, network, and cost requirements.

---

## Architecture

```text
Browser
  ├─ MediaRecorder (default push-to-talk)
  ├─ SSE reader + ordered audio queue + autoplay recovery
  ├─ optional RTCPeerConnection + oai-events data channel
  └─ session hydration, workflow panel, share links
        │
        ▼
proxy.ts ── per-request nonce + strict Content Security Policy
        │
        ▼
Next.js route handlers (Node runtime)
  ├─ conversation: chat, voice, history, reset
  ├─ workflow: state, summary, shareable transcript
  ├─ observability: health, ready, metrics
  ├─ realtime: ephemeral token, usage reporting
  └─ guard: rate limit → production gate → access code → daily budget
        │
        ▼
lib/
  ai.ts               pooled OpenAI client: STT / LLM stream + tool loop
  tts.ts / realtime-tts.ts   ordered TTS provider chain
  streaming.ts        turn lifecycle: lock, deltas, commit, workflow refresh
  telemetry.ts        turn traces + bounded p50/p95 registry
  evals.ts            deterministic pass@1 / pass@5 scoring
  workflow-*.ts       durable state, tools, deterministic summary
  guard.ts / ratelimit.ts    access control and AI budget
  conversation.ts     TTL + LRU-bounded in-memory history
  csp.ts / realtime-events.ts / realtime-budget.ts
```

### Turn guarantees

- One turn per session at a time via a per-session mutex.
- `session → transcript? → delta… → done → workflow? → audio…` is the SSE order. `workflow` is additive and may be observed after `audio`.
- Heartbeat comments keep idle streams alive; `TURN_TIMEOUT_MS` aborts a stalled turn.
- Client-aborted streams keep their budget reservation because provider work may already have been billed. Failures before useful output refund it.
- TTS failures degrade to text, not a failed turn.

---

## Tech stack

| Layer | Choice |
| --- | --- |
| Runtime | Node.js 22+ |
| Framework | Next.js 16 App Router, React 19 |
| Language | TypeScript (strict) |
| STT | OpenAI `gpt-transcribe`, JSON response, reads `.text` |
| LLM | OpenAI `gpt-6-luna`, Chat Completions + tools, `reasoning_effort: "none"` |
| TTS | `gpt-realtime-2.1-mini` narration with `speech` failover |
| Search | Tavily when configured, otherwise keyless DuckDuckGo Lite + cheerio |
| Default transport | SSE for text/audio; JSON for blocking fallbacks |
| Optional transport | WebRTC + Realtime data channel |
| Workflow store | Atomic JSON file, single-instance by design |
| Tests | Vitest, 121 network-free tests |
| Evals | Deterministic offline dataset, no model required |

---

## Quick start

There is no committed `.env.example`. Create `.env.local` yourself:

```bash
npm ci
printf 'OPENAI_API_KEY=sk-your-key\n' > .env.local
npm run dev
```

On Windows PowerShell:

```powershell
Set-Content .env.local 'OPENAI_API_KEY=sk-your-key'
```

Open <http://localhost:3000>. Smoke test without a microphone:

```bash
curl -s http://localhost:3000/api/health
curl -s http://localhost:3000/api/ready
curl -sN -X POST http://localhost:3000/api/chat/stream \
  -H 'Content-Type: application/json' \
  -d '{"session_id":"demo-session","message":"Hi there!","speak":false}'
```

To try the optional live path, add `REALTIME_ENABLED=true` to `.env.local`, restart, and select **Live voice** in the header.

---

## Configuration

Next.js loads `.env.local` for `dev`, `build`, and `start`. On a host, set the same names in the dashboard/secret store. All config is read from the environment; no secrets are baked into the browser bundle.

### Required

| Variable | Purpose |
| --- | --- |
| `OPENAI_API_KEY` | Server-side key for STT, LLM, narration, and optional Realtime. Never sent to the browser. |

### Models and TTS

| Variable | Default | Notes |
| --- | --- | --- |
| `STT_MODEL` | `gpt-transcribe` | JSON transcription; the app reads `.text`. Also used for Realtime input transcription. |
| `LLM_MODEL` | `gpt-6-luna` | Chat Completions + function calling. |
| `LLM_REASONING_EFFORT` | `none` | Required for tools on `gpt-6-luna`. Use `default`, `off`, or empty to omit the field. |
| `TTS_PROVIDER` | `realtime` | Primary narrator: `realtime` or legacy `speech`. |
| `TTS_FALLBACK_PROVIDER` | `speech` | Second adapter. Set `none`/`off` to stop after the primary. |
| `REALTIME_TTS_MODEL` | `gpt-realtime-2.1-mini` | Realtime narrator model. |
| `REALTIME_TTS_VOICE` | `marin` | Realtime narrator voice. |
| `REALTIME_TTS_INSTRUCTIONS` | see `lib/config.ts` | Narration style instructions. |
| `TTS_MODEL` | `gpt-4o-mini-tts` | Legacy Speech model; used only by the `speech` adapter. |
| `TTS_VOICE` | `alloy` | Legacy Speech voice. |
| `MAX_TOOL_ROUNDS` | `4` | Bounded tool loop. |
| `MAX_REPLY_TOKENS` | `600` | Sent as `max_completion_tokens`. |
| `OPENAI_TIMEOUT_MS` | `30000` | Provider request timeout. |
| `OPENAI_MAX_RETRIES` | `2` | Provider retries. |

`/api/ready` reports the effective chain, for example:

```json
{ "status": "ready", "tts": { "primary": "realtime", "fallback": "speech", "chain": ["realtime", "speech"] } }
```

> **Model lifecycle:** the Speech API models shut down **2027-01-06**, `gpt-4o-mini` on **2027-01-14**, and `gpt-4o-mini-transcribe` on **2027-02-26**. Voxen defaults to the Realtime narrator and keeps `speech` only as a time-boxed failover. Set `TTS_FALLBACK_PROVIDER=none` after retiring the legacy adapter.

### Search

| Variable | Default | Notes |
| --- | --- | --- |
| `SEARCH_PROVIDER` | `auto` | `auto`, `tavily`, or `duckduckgo`. |
| `TAVILY_API_KEY` | — | Recommended for production. |
| `SEARCH_TIMEOUT_MS` | `8000` | Per-search timeout. |

`auto` uses Tavily when a key is present and otherwise the keyless DuckDuckGo scraper. Tavily failures fall back to DuckDuckGo. Search results are treated as untrusted third-party text.

### Conversation, limits, and streaming

| Variable | Default | Notes |
| --- | --- | --- |
| `MAX_HISTORY_MESSAGES` | `20` | Messages kept after the system prompt. |
| `SESSION_TTL_MS` | `1800000` | 30 minutes of inactivity. |
| `MAX_SESSIONS` | `1000` | LRU eviction beyond this. |
| `MAX_AUDIO_BYTES` | `4194304` | Decoded audio cap. |
| `MAX_AUDIO_SECONDS` | `60` | Client-reported duration; `audio_duration` is required. |
| `MAX_MESSAGE_CHARS` | `4000` | Text input cap. |
| `MAX_CHAT_REQUEST_BYTES` | `65536` | JSON request cap. |
| `MAX_VOICE_REQUEST_BYTES` | `4718592` | Multipart request cap. |
| `RATE_LIMIT_REQUESTS` | `20` | Per client, per route group, per window. |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Window length. |
| `DAILY_REQUEST_BUDGET` | `1000` | Shared AI request cap per UTC day. |
| `TURN_TIMEOUT_MS` | `90000` | Hard cap for one streamed turn. |
| `SSE_HEARTBEAT_MS` | `15000` | Keep-alive cadence. |

### Identity and billing

| Variable | Default | Notes |
| --- | --- | --- |
| `IDENTITY_SECRET` | — | HMAC secret for API-key hashes. Required when identity mode is enabled. |
| `MIN_IDENTITY_SECRET_LENGTH` | `16` | Production refuses a shorter signing secret. |
| `IDENTITY_REQUIRED` | `false` | Set `true` to reject requests without an API key. |
| `ADMIN_API_KEY` | — | Bootstrap admin key for `/admin` and `/api/admin/*`; never stored. Also works when `IDENTITY_REQUIRED=true`. |
| `MIN_ADMIN_KEY_LENGTH` | `16` | Production refuses a shorter bootstrap admin key. |

Identity mode is opt-in so existing access-code deployments keep working. Once accounts are provisioned, set `IDENTITY_REQUIRED=true` and `IDENTITY_SECRET` to a long random value. The access-code gate still applies to every route; identities add per-account rate limits, quotas, and usage attribution. API keys are `vk_…` bearer tokens, returned once at creation and stored only as HMAC hashes. A disabled key is rejected immediately.

Plans are `free` (50 requests/day, no meter), `pro` (1,000/day), and `enterprise` (20,000/day). Meter rates in `lib/billing.ts` are illustrative micro-dollar values; replace them with your provider cost table before charging customers. Daily quota rows and Realtime audio/token usage live in the selected state backend; session usage and the account meter are recorded in one atomic write. `STATE_BACKEND=file` or a future shared adapter is required for consistent caps across instances.

### Shared state

| Variable | Default | Notes |
| --- | --- | --- |
| `STATE_BACKEND` | `memory` | `memory` is per process; `file` shares one atomic document across instances on the same host or mounted volume. |
| `STATE_STORE_PATH` | `.data/voxen-state.json` | State document for the `file` backend. Must be writable by every instance. |
| `STATE_LOCK_TIMEOUT_MS` | `5000` | Max wait for the cross-process file lock. |
| `STATE_LOCK_STALE_MS` | `10000` | Age at which an abandoned lock may be reclaimed. |

The `StateBackend` contract in `lib/state/contract.ts` exposes atomic `read`/`write`/`reset` operations over one document. Rate limits, the daily budget, conversation history, Realtime usage, and telemetry all go through it, so switching to `file` makes those caps shared without changing route code. Workflow bookings keep their own atomic file and audit trail; a corrupt state file fails closed rather than resetting caps. Redis/Postgres adapters can implement the same contract when instances run on different machines.

### Live eval tracing

| Variable | Default | Notes |
| --- | --- | --- |
| `EVAL_TRACE_ENABLED` | `false` | Opt in only on an isolated evaluation deployment. |
| `EVAL_TRACE_PATH` | `.data/eval-traces.jsonl` | Append-only JSONL trace file; use a shared volume if several instances record. |
| `EVAL_TRACE_MAX_BYTES` | `5242880` | Oldest lines are removed when the file exceeds this size. |
| `EVAL_TRACE_MAX_ROWS` | `2000` | Maximum retained traces. |
| `EVAL_TRACE_MAX_ANSWER_CHARS` | `4000` | Answer text cap; no prompt text is stored. |

When enabled, chat, streaming, and Realtime turns append sanitized traces with a request id, hashed session id, timings, tool names, lifecycle events, answer text, and prompt length. Labels are accepted only from `x-eval-case-id`, `x-eval-attempt-id`, and `x-eval-dimension` headers; they never grant access or budget. Raw session ids and user transcript text are never written; the assistant answer is capped because eval scoring needs it.

### Workflow

| Variable | Default | Notes |
| --- | --- | --- |
| `WORKFLOW_ENABLED` | `true` | Set `false` to remove scheduling tools and the `workflow` SSE event. |
| `WORKFLOW_STORE_PATH` | `.data/voxen-workflow.json` | Atomic JSON store; `.data/` is gitignored. |
| `APPOINTMENT_MINUTES` | `30` | Slot length and alignment. |
| `CONFIRMATION_TTL_MS` | `600000` | How long a prepared appointment may be confirmed. |
| `SHARE_TTL_MS` | `86400000` | Lifetime of a shareable transcript token. |

Slots are future weekdays from **09:00–17:00 UTC**, aligned to `APPOINTMENT_MINUTES`. The model must call `find_appointment_slots`, then `prepare_appointment`, and only call `confirm_appointment` after an explicit user agreement. `confirm_appointment` requires `confirm: true`; a double-booking returns `slot_taken`. `cancel_appointment` uses the confirmation code, and `handoff_to_human` records a reason. A corrupt store fails closed with `500 CONFIG_ERROR` rather than silently losing bookings.

### Realtime/WebRTC

| Variable | Default | Notes |
| --- | --- | --- |
| `REALTIME_ENABLED` | `false` | Must be exactly `true` to expose the transport. |
| `REALTIME_MODEL` | `gpt-realtime-2.1-mini` | Full-duplex speech-to-speech model. |
| `REALTIME_VOICE` | `marin` | Live voice. |
| `REALTIME_INSTRUCTIONS` | see `lib/config.ts` | Session policy, kept server-side. |
| `REALTIME_MAX_SESSIONS` | `3` | Concurrent sessions per session id. |
| `REALTIME_MAX_AUDIO_SECONDS` | `180` | Audio-minute cap per session. |
| `REALTIME_MAX_OUTPUT_TOKENS` | `4000` | Output-token cap per session. |

The token route sets `OpenAI-Safety-Identifier` to a redacted session hash, reserves a session before minting, and refunds the reservation on upstream failure. Usage is reported when the browser session ends. The CSP includes `https://api.openai.com` and `wss://api.openai.com` only while this flag is enabled.

### Access, proxy, and metadata

| Variable | Default | Notes |
| --- | --- | --- |
| `TRUST_PROXY_HOPS` | auto | `1` on Vercel/Render/Fly, otherwise `0`. Set explicitly behind other proxies. |
| `ACCESS_CODE` | — | Shared secret sent as `x-access-code`; UI shows a gate. Required in production. |
| `MIN_ACCESS_CODE_LENGTH` | `16` | Production minimum. |
| `REQUIRE_ACCESS_CODE` | `true` | Set `false` only for a deliberately public production deploy. |
| `APP_VERSION` | `1.1.0` | Reported by `/api/health`. |

Production fails closed: a missing or short `ACCESS_CODE` makes guarded routes return `503 CONFIG_ERROR`, and `/api/ready` reports `access_code_not_configured`. `TRUST_PROXY_HOPS=0` ignores `X-Forwarded-For`, so a direct deployment cannot be spoofed into bypassing rate limits.

---

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

A missing or invalid `audio_duration` returns `400 INVALID_AUDIO_DURATION` before STT or budget reservation. Blocking routes exist for clients that cannot consume SSE.

### Observability

| Route | Notes |
| --- | --- |
| `GET /api/health` | Public liveness. Includes `access_required` and `realtime_enabled`. `?verify=1` checks an access code; `?detail=1` adds config, budget, sessions, workflow stats, and TTS chain. Both query modes are guarded. |
| `GET /api/ready` | Orchestrator readiness. Fails when AI is missing or production access is misconfigured. |
| `GET /api/metrics` | Guarded state-backend telemetry. Consumes no AI budget and exposes no transcript content. |

Example `/api/metrics` shape:

```json
{
  "status": "ok",
  "counters": { "turn.ok": 12, "turn.error.TTS_FAILED": 1 },
  "timings": {
    "stage.stt": { "count": 13, "p50": 310, "p95": 720, "max": 910 },
    "turn.total": { "count": 13, "p50": 1420, "p95": 2600, "max": 3100 }
  }
}
```

Traces are also emitted as structured `turn.trace` log events with milestones `transcript`, `first_delta`, `done`, `first_audio`, `complete`; stages `stt`, `llm`, `tts`; a request id; and a hashed session id. Live turns replay browser-measured markers and add a `transport: "realtime"` field plus `turn.transport.realtime` / `realtime.interrupted` counters. Values live in the selected state backend and are bounded to the last 500 samples per metric.

### Workflow and sharing

| Route | Notes |
| --- | --- |
| `GET /api/workflow` | `x-session-id` or `?session_id=`. Returns `enabled`, `workflow`, `appointments`, and aggregate `stats`. |
| `POST /api/workflow/summary` | `{ session_id }`. Returns deterministic `headline`, `action_items`, `decisions`, `share_token`, `share_url`, and `share_expires_at`. |
| `POST /api/workflow/share/revoke` | `{ session_id, share_token }`. Revokes a link for its owning session; unknown or foreign tokens return `{ revoked: false }`. |
| `GET /api/transcript/{token}` | Read-only, expiring shared transcript. The high-entropy token is the bearer secret; the payload omits the session id and includes expiry. |

The summary is computed locally from committed history and persisted workflow state—no extra model call, so it is instant, cheap, and reproducible for evals. Booking requires a one-time `confirmation_token` returned by `prepare_appointment`: only its hash is persisted, it expires after `CONFIRMATION_TTL_MS`, and a successful booking consumes it. Appointments record the source transport, creator, confirmation time, and cancellation actor.

### Accounts and admin

| Route | Notes |
| --- | --- |
| `GET /api/account` | Requires an API key. Returns the account, daily quota, and metered usage. |
| `GET /api/admin/accounts` | Lists accounts without key hashes. Requires `x-admin-key` or an admin-role account. |
| `POST /api/admin/accounts` | `{ name, email?, plan?, role? }`. Returns the account and its one-time `api_key`. |
| `PATCH /api/admin/accounts` | `{ id, plan?, status?, role? }`. Updates plan, status, or role. |
| `GET /api/admin/usage` | Usage rows and totals by account and UTC day. |
| `GET /api/admin/billing` | Invoice-style plan base, request meter, Realtime meter, and totals. |

The `/admin` page is a small operator UI for the same routes. It keeps the admin key in `sessionStorage` only, shows generated API keys once, and never displays key hashes.

### Realtime

| Route | Notes |
| --- | --- |
| `POST /api/realtime/token` | `{ session_id }`. Guarded; returns `{ value, expires_at?, session_id, model, limits }`. Includes the active tool schemas. Disabled unless `REALTIME_ENABLED=true`. |
| `POST /api/realtime/tool` | `{ session_id, call_id, name, arguments }`. Guarded; runs only advertised tools with the server-owned session id. Does not consume another AI budget unit. |
| `POST /api/realtime/turn` | `{ session_id, user_text, assistant_text, interrupted?, elapsed_ms?, milestones_ms?, stages_ms? }`. Guarded; commits the final live turn and returns history plus workflow state. |
| `POST /api/realtime/usage` | `{ session_id, audio_seconds, output_tokens }`. Guarded; enforces caps, records final usage, and releases the session reservation. |

Token setup failures fall back to standard voice mode. Budget errors are surfaced in the conversation; stop the live session to return to standard voice.

### Streaming events

| Event | Payload | Meaning |
| --- | --- | --- |
| `session` | `{ session_id }` | Session resolved or created. |
| `transcript` | `{ transcript }` | Voice routes only: STT result. |
| `delta` | `{ text }` | Incremental model text. |
| `audio` | `{ index, audio }` | Base64 WAV for one sentence; play in index order. |
| `done` | `{ session_id, reply, history, spoken }` | Turn committed. May arrive before remaining audio. |
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
| 503 | `CONFIG_ERROR` (production access gate or identity secret missing/short, or Realtime disabled) |

An open stream reports `TURN_TIMEOUT` in its `error` event rather than as an HTTP status. In production, 5xx messages are replaced with a generic string.

---

## Security and cost controls

- `OPENAI_API_KEY` is server-only. Realtime browsers receive only a short-lived client secret.
- Guard order is **rate limit → identity → production access gate → access code → daily budget/quota**. Production fails closed before paid work.
- Access-code attempts are rate-limited and compared in constant time. API keys are HMAC-hashed, format-checked, looked up in constant time, and rejected immediately when disabled.
- Authenticated requests are rate-limited by account id; anonymous requests use the validated client address. Quota and global budget reservations are atomic.
- Admin routes require the bootstrap `ADMIN_API_KEY` or an admin-role account; the bootstrap key is never stored, is compared as a hash in constant time, and remains valid when identity mode is required.
- Failed turns refund their budget reservation; client aborts intentionally keep it.
- Body bytes are capped before JSON/multipart parsing; audio has required duration plus size checks.
- Turns are serialized per session; streams have heartbeats and hard deadlines.
- Session ids are bearer tokens: strict validation, header transport, and hashed logging via `redactSessionId()`.
- Realtime function calls use a server-side tool allowlist and the server-owned session id; only the final response after tool continuations is committed.
- Share tokens are separate bearer secrets; shared payloads omit the session id, expire after `SHARE_TTL_MS`, and can be revoked by the owning session.
- Appointment confirmations require a hashed, expiring, single-use token; audit fields record source, creator, confirmation time, and cancellation actor.
- History is TTL-expired and LRU-bounded; telemetry samples and tracked Realtime sessions are bounded too.
- Documents receive a nonce-based CSP, HSTS in production, and strict frame/origin policies. Realtime origins are added only under the flag.
- Errors expose stable codes and request ids without stack traces.
- The Docker image runs as a non-root user and checks `/api/ready`.

**Scaling boundary:** with `STATE_BACKEND=memory` all state is per process. Set `STATE_BACKEND=file` with a shared volume to share rate limits, budget, account keys, quotas, usage, history, Realtime usage, and telemetry across local instances; workflow bookings already use their own atomic file. Use a Redis/Postgres implementation of `StateBackend` before running instances on different machines that must share hard caps or customer metering.

---

## Testing and evals

```bash
npm run check          # typecheck + 185 unit tests
npm test               # Vitest, no network or API key
npm run test:e2e       # Playwright browser E2E (8 scenarios)
npm run test:e2e:install # installs the Chromium binary once
npm run audit          # production dependency audit
npm run build          # Next.js standalone build
npm run eval           # deterministic offline eval dataset
npm run eval:gate      # thresholds + committed-baseline regression check
npm run eval:live      # score labeled live traces instead of the offline dataset
npm run eval:baseline  # regenerate evals/baseline.json after an intentional change
```

Unit tests need no API key or network. Coverage includes:

- blocking and streaming route contracts
- SSE order, `done` before audio, heartbeats, and turn deadlines
- TTS provider chain and mocked failover
- health/ready reporting, access gate fail-closed behavior, and budget refunds
- telemetry traces, percentiles, and guarded metrics
- eval scoring, pass@1/pass@5, dataset parsing, and deterministic CI gates
- durable appointment store: atomic writes, conflicts, cancellation, corrupt-store fail-closed
- scheduling tools, session-scoped workflow state, one-time confirmations, summaries, share expiry, and revocation
- Realtime token/usage routes, concurrent session caps, CSP policy, and event parsing
- Realtime tool execution, deferred turn commits, session reservation release, and browser data-channel behavior
- shared-state contract for memory/file backends, cross-instance visibility, fail-closed corrupt state, and module integration
- opt-in live eval traces: header label sanitization, text/session redaction, file bounds, and trace-to-dataset conversion
- API account hashing, disabled-key rejection, admin authorization, quota enforcement/refunds, and Realtime metering
- admin route contracts for account provisioning, updates, usage, and billing reports

Playwright mocks the OpenAI/app routes and runs the real browser client. `playwright.config.ts` starts a dev server on port 3100 with a placeholder key, Realtime flagged on, and access codes disabled. The E2E suite covers:

- streamed text turns and server session adoption
- autoplay blocking and manual replay recovery
- skipped speech chunks after a failed narrator (the client-side failover path)
- the access gate and stored access code
- summary share links with expiry plus owner-only revocation
- live function calls and final-only Realtime turn commits
- barge-in telemetry from a live turn
- admin dashboard rendering accounts, usage totals, and billing totals

`npm run eval` reads `evals/dataset.json` and scores recorded attempts across `timing`, `recovery`, and `grounded` dimensions. It is deterministic and offline; the bundled dataset currently reports **pass@1=55%, pass@5=100%**. Add your own cases by appending `{ testCase, attempts }` entries.

`npm run eval:gate` adds explicit floors from `evals/thresholds.json` and compares against `evals/baseline.json`, so a score drop fails the build even when it stays above the floor. Both files are checked in; regenerate the baseline only after an intentional quality change. The gate needs no API key or network, and CI runs it on every push and pull request.

`npm run eval:live` reads `.data/eval-traces.jsonl`, keeps the original case thresholds, and replaces attempts with labeled live traffic. Record on an isolated deployment with `EVAL_TRACE_ENABLED=true`, then send `x-eval-case-id`, `x-eval-attempt-id`, and `x-eval-dimension` headers from the eval client. Only successful, labeled traces are scored.

CI runs `npm ci`, `npm run audit`, `npm run typecheck`, `npm test`, `npm run eval:gate`, `npm run build`, and the Playwright suite with a placeholder key. On Windows, use `npm.cmd` in PowerShell.

---

## Deployment

### Node

```bash
npm ci
npm run build
npm start
```

Set the production environment before starting, especially `OPENAI_API_KEY` and either a long `ACCESS_CODE` or `REQUIRE_ACCESS_CODE=false`.

### Docker

```bash
docker build -t voxen .
docker run --env-file .env.local -p 3000:3000 voxen
```

Mount a writable volume and set `WORKFLOW_STORE_PATH` for appointment state that survives container replacement. For multi-instance caps on one host, also set `STATE_BACKEND=file` and `STATE_STORE_PATH=/data/voxen-state.json` on the same volume. Mount `/data` with permissions for uid 1001.

### Production checklist

- Use HTTPS so microphone access and WebRTC are allowed.
- Set `TRUST_PROXY_HOPS` if behind a proxy that supplies `X-Forwarded-For`.
- Confirm `/api/ready` returns `ready` and the expected TTS chain.
- Watch `/api/metrics` for p95 latency and provider failures.
- Keep `REALTIME_ENABLED=false` until you have tested the flag with your account and browser matrix.
- Use `STATE_BACKEND=file` with a shared volume for local multi-instance caps, or implement the state contract on Redis/Postgres across machines.
- Set `TTS_FALLBACK_PROVIDER=none` after the legacy Speech API shutdown.

---

## Project structure

```text
app/
  api/
    chat/route.ts                 blocking text turn
    chat/stream/route.ts          streamed text turn (SSE)
    voice/route.ts                blocking audio turn
    voice/stream/route.ts         streamed audio turn (SSE)
    history/route.ts              session hydration
    reset/route.ts                clear a session
    health/route.ts               liveness + feature flags
    ready/route.ts                readiness + TTS chain
    metrics/route.ts              guarded telemetry snapshot
    workflow/route.ts             persisted workflow state
    workflow/summary/route.ts     post-call summary + share
    workflow/share/revoke/route.ts owner-only share revocation
    transcript/[token]/route.ts   expiring shared transcript
    realtime/token/route.ts       ephemeral client secret
    realtime/tool/route.ts        guarded live tool execution
    realtime/turn/route.ts        guarded final-turn commit
    realtime/usage/route.ts       final Realtime usage
  components/
    VoiceAgent.tsx                client state machine
    AccessGate.tsx                optional preview gate
    AdminDashboard.tsx            operator accounts/usage UI
    Icons.tsx
    voice-agent/
      stream.ts                   SSE parser + API errors
      realtime.ts                 WebRTC session + data channel
      useRecorder.ts              push-to-talk recorder
      useAudioQueue.ts            ordered playback
      Messages.tsx                thread rendering
  admin/page.tsx                  guarded operations page
  globals.css / layout.tsx / page.tsx / error.tsx / not-found.tsx
lib/
  ai.ts openai-client.ts tts.ts realtime-tts.ts streaming.ts
  telemetry.ts evals.ts eval-gate.ts eval-trace.ts
  identity.ts billing.ts
  workflow-store.ts workflow-tools.ts workflow-summary.ts
  realtime-budget.ts realtime-events.ts csp.ts config.ts
  guard.ts ratelimit.ts conversation.ts session-lock.ts
  state/contract.ts state/memory.ts state/file.ts state/index.ts
  tools.ts body.ts validate.ts errors.ts http.ts logger.ts sse.ts sse-response.ts
proxy.ts                          CSP nonce + document policy
evals/dataset.json                offline eval cases
evals/thresholds.json             explicit CI floors
evals/baseline.json               committed regression baseline
scripts/evals.mts                 eval runner with gate and live-trace modes
scripts/start.mjs                 standalone launcher
tests/                            22 test files, 185 unit tests
e2e/                              Playwright browser scenarios
playwright.config.ts              E2E web server + browser config
Dockerfile next.config.mjs vitest.config.mts
.github/workflows/ci.yml
```

---

## Why these tradeoffs

- Market research in Nov 2026 put AI-agent deployment at **57%** with **82%** reporting positive ROI, but EVA-Bench found no system above **0.5** on both accuracy and experience. That favors a narrow, confirmable workflow and measured reliability over broad autonomy.
- The observed market median for voice responses is roughly **680 ms**. Voxen records stage and total percentiles and includes an opt-in Realtime path rather than pretending the SSE cascade is sub-second.
- Speech APIs are being replaced by Realtime-style interfaces. Voxen migrates narration now but keeps a reversible failover and documents the shutdown dates.
- Full-duplex transport changes security, cost, and testing conditions. It stays behind a flag with explicit audio/token caps and a safe fallback.

---

## Roadmap

1. **Remote shared state** — Redis/Postgres implementations of `StateBackend` and a shared workflow store for multi-machine fleets.
2. **Payment provider integration** — Stripe checkout, webhooks, and invoice finalization on top of the existing usage meter.
3. **Workflow depth** — rescheduling, calendar integration, reminders, and support handoff records.
4. **Realtime hardening** — richer browser/device matrix and measured latency targets.
5. **Eval breadth** — more labeled live scenarios and provider-specific baselines.

> First make it work. Then make it fast. Then make it reliable. Then make it scalable.
