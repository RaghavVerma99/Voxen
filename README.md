# Voice Agent — MVP

A browser-based **AI voice assistant**: talk into your microphone, see your transcript, get an LLM answer, and hear it spoken back — including web-search tool calling — all served from a single FastAPI service.

> **Phase:** MVP (Milestone 0–6 of `voice_agent_mvp.md`). It works, it's tested, it's deployable.
> The long-term architecture and roadmap living in `distributed_voice_agent_project.md` are intentionally **not** implemented yet.

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
┌─────────────────┐
│ Browser Frontend │  HTML/CSS/JS, MediaRecorder (webm/opus)
│ (served by same │  1. records audio (push-to-talk)
│     backend)    │  2. uploads via multipart POST
└────────┬────────┘
         │ HTTP POST /api/voice  (multipart: audio, session_id, audio_duration)
         ▼
┌───────────────────────────────┐
│      FastAPI backend          │
│                               │
│  main.py        ─ routing + error mapping
│  conversation.py─ in-memory session-keyed history
│  ai.py          ─ OpenAI provider calls (STT / LLM / TTS)
│  tools.py       ─ search_web() via DuckDuckGo
│  schemas.py     ─ Pydantic request/response models
│  config.py      ─ env-driven settings
└──────┬────────────────────────┘
       │
       ├──► gpt-4o-mini-transcribe   (OpenAI)   audio → text
       ├──► gpt-4o-mini + tools      (OpenAI)   text → reply (can call search_web)
       │        └─► DuckDuckGo       (ddgs)     query → results
       ├──► gpt-4o-mini-tts          (OpenAI)   text → mp3 (base64 in JSON)
       │
       ▼
  Speaker output in browser
```

**Deployment topology:** the static frontend is served by the backend itself (`/` mount). One service, no CORS in production, no separate static host.

---

## Request lifecycle

### Voice path

```
MediaRecorder captures webm/opus  (max 60s, auto-stop timer)
        │
        ▼
POST /api/voice  (multipart)
        │
        ├─ validations: non-empty < 10MB, duration ≤ max_audio_seconds
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
200 {"transcript", "reply", "audio", "history"}   → frontend plays audio, renders chat
```

### Text path (`/api/chat`)

Same pipeline minus audio capture/STT/TTS — used for quick testing without a microphone.

---

## Tech stack

| Layer | Choice | Version tested | Why |
| --- | --- | --- | --- |
| Runtime | Python | 3.14 local / 3.12 Docker | 3.14 is this machine's interpreter; image pinned to 3.12-slim for portability |
| API framework | FastAPI + Uvicorn | fastapi 0.141 / uvicorn 0.53 | Async, typed Pydantic contracts, effortless static mounting |
| Frontend | Vanilla HTML/CSS/JS | — | No build step, trivially static-hostable |
| STT | OpenAI `gpt-4o-mini-transcribe` | openai SDK 3.x | Cheap one-shot transcription; one API key for all AI |
| LLM | OpenAI `gpt-4o-mini` | openai SDK 3.x | Fast, cheap, supports function calling |
| TTS | OpenAI `gpt-4o-mini-tts` (voice `alloy`, mp3) | openai SDK 3.x | Good quality per dollar; single key |
| Web search | DuckDuckGo via `ddgs` | ddgs 9.x | Zero API key → MVP keeps just one secret |
| Validation | Pydantic v2 | 2.13 | Built into FastAPI |
| Testing | pytest + TestClient | pytest 9.x | Mocked AI layer → runs with no key/no network |

Requirements are pinned as **floors** (`>=`) in `backend/requirements.txt` rather than exact pins — CI/Docker resolve the latest compatible versions.

---

## Key design decisions

Documented so the *why* survives the *what*.

| # | Decision | Rationale |
| --- | --- | --- |
| 1 | **One deployable unit** — backend mounts and serves `frontend/` | Static frontend + API on one Render/Railway service removes CORS entirely for MVP. Split later if the frontend grows into React. |
| 2 | **Session-keyed conversations in memory** (`dict[session_id, messages]`) | Fixes the original plan's global-list bug: two users no longer corrupt one shared history, and `/api/reset` clears **only** the target session. No DB needed for MVP. |
| 3 | **History is server-owned**, capped at last 20 messages after the system prompt | Client sends only `session_id`; server builds context. The cap bounds token usage instead of letting histories grow unbounded. |
| 4 | **Audio returned as base64 mp3 in JSON** | Frontend stays trivial: `new Audio("data:audio/mpeg;base64,"+b64)`. No signed-URL endpoints, no storage. |
| 5 | **Half-duplex HTTP, not WebSocket streaming** | The MVP prioritizes a *reliable* loop over a *low-latency* one. Streaming (WebSocket/WebRTC) is the explicit next phase — see `distributed_voice_agent_project.md`. Expected full round trip ≈ 5–15 s. |
| 6 | **`response_format="text"` on STT** | Returns a plain string instead of a JSON wrapper — least parsing surface. |
| 7 | **LLM tool-calling loop, ≤ 4 rounds** | The agent can call `search_web`, receive results, and answer. Rounds are bounded so a loop cannot spin forever. Unknown tools → structured error string the LLM sees, never an exception. |
| 8 | **DuckDuckGo (no key) inside `tools.py`** | Keeps the MVP to a single secret (`OPENAI_API_KEY`). Trade-off: DDG is best-effort; quality improves later by swapping the one function behind the same `run_tool` interface. |
| 9 | **TTS failure does not fail the request** | If speech generation fails, the client still gets `reply` text and `audio: null`. Text always wins; speech is best-effort. |
| 10 | **Typed error contract** — every error carries `{error_code, message}` | The frontend shows a stable message, and future tooling (monitoring, retries) can branch on `error_code` instead of HTTP-status heuristics. |
| 11 | **CORS only when configured** | Middleware is added only when `CORS_ORIGINS` is non-empty; the recommended same-origin deployment stays open without extra config. |
| 12 | **API key lives in env; an OpenAI client is built per call** (`ai._new_client()`) | The browser never touches `OPENAI_API_KEY`; building per call lets config and tests vary cleanly. |
| 13 | **Frontend single-flight + status state machine** | Controls disable during processing so overlapping uploads can't interleave conversation history; status (`ready → recording → thinking → speaking → error`) drives all UI feedback. |

---

## API reference

### `GET /health`

Liveness probe.

```json
200 {"status": "ok"}
```

### `POST /api/chat`

Text-only turn. State is server-side and session-keyed; a missing `session_id` creates a new one (returned in the response).

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

The core endpoint. `multipart/form-data` fields:

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

```python
conversations: dict[str, list[dict]] = {
    "session-id": [
        {"role": "system",    "content": <SYSTEM_PROMPT>},   # always first
        {"role": "user",      "content": "…"},
        {"role": "assistant", "content": "…"},
        # … capped at max_history_messages (default 20) + the system prompt
    ]
}
```

- Lives in-process (module dict in `conversation.py`) — **lost on restart/redeploy**, by design for MVP.
- The system prompt tells the model to respond naturally and concisely, and to use `search_web` for anything after its knowledge cutoff.
- Truncation keeps the newest 20 messages after the system prompt to bound LLM token usage.

---

## Frontend behavior

Plain vanilla JS — no framework, no build step.

- **Push-to-talk:** click to record → click again, or the recorder **auto-stops at 60 s**.
- **Microphone denied:** shows a message; the app stays usable.
- **Single flight:** all controls disabled from upload until the response finishes or errors.
- **Status states:** `Ready → Recording… → Thinking… → Speaking… → Ready`, plus `Error` on failure — one element (`#status`) drives the whole UI.
- **Session persistence:** `session_id` stored in `localStorage` (via `crypto.randomUUID`), so reloads keep the same conversation server-side.
- **Audio playback:** `Audio` element with a `data:audio/mpeg;base64,…` source; plays automatically once the reply renders.
- **Reset:** clears server history via `/api/reset` and empties the transcript log locally.

---

## Error model

| HTTP | `error_code` | Meaning |
| --- | --- | --- |
| 400 | `EMPTY_MESSAGE` | `/api/chat` message is blank |
| 400 | `MISSING_SESSION` | `/api/reset` without `session_id` |
| 400 | `EMPTY_AUDIO` | No audio bytes uploaded |
| 413 | `AUDIO_TOO_LARGE` | Upload exceeds `MAX_AUDIO_BYTES` (10 MB) |
| 413 | `AUDIO_TOO_LONG` | `audio_duration` exceeds `MAX_AUDIO_SECONDS` (60 s) |
| 400 | `NOTHING_HEARD` | STT returned no speech |
| 502 | `STT_FAILED` | Transcription call failed (bad key, upstream 5xx, timeout, …) |
| 502 | `LLM_FAILED` | Chat-completions or tool-loop failure |

Error responses carry the shape `{"detail": {"error_code": …, "message": …}}` (FastAPI's HTTPException detail).

**`TTS_FAILED` never surfaces** — TTS exceptions are swallowed and `audio` is returned as `null` (decision #9). Tool-execution errors are returned *as tool output for the LLM*, not as API errors.

---

## Configuration

All settings come from environment variables via `python-dotenv`, loaded from the backend working directory upward — so either `backend/.env` or a repo-root `.env` works.

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENAI_API_KEY` | *(required)* | Key for all three OpenAI calls. Never in the browser. |
| `STT_MODEL` | `gpt-4o-mini-transcribe` | Transcription model |
| `LLM_MODEL` | `gpt-4o-mini` | Chat model |
| `TTS_MODEL` | `gpt-4o-mini-tts` | Speech synthesis model |
| `TTS_VOICE` | `alloy` | OpenAI voice name |
| `CORS_ORIGINS` | *(empty)* | Comma-separated allowlist; middleware added only when non-empty |
| `MAX_HISTORY_MESSAGES` | `20` | Conversation cap (after the system prompt) |
| `MAX_AUDIO_BYTES` | `10485760` | 10 MB server-side upload cap |
| `MAX_AUDIO_SECONDS` | `60` | Duration guard fed by the client's `audio_duration` |

See `.env.example` for a template.

---

## Local development

```bash
# 1. Create the env (uv preferred — this machine has no python3-venv)
uv venv .venv
uv pip install -p .venv -r backend/requirements.txt

# 2. Configure the OpenAI key — never commit it
cp .env.example backend/.env        # edit backend/.env, set OPENAI_API_KEY

# 3. Run (the server also serves the frontend at the root)
cd backend
../.venv/bin/uvicorn main:app --reload --port 8000
```

Open http://localhost:8000

Quick API smoke test without a microphone:

```bash
curl -s http://localhost:8000/health
curl -s -X POST http://localhost:8000/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"session_id":"demo","message":"Hi there!"}'
```

---

## Testing

```bash
cd backend && ../.venv/bin/python -m pytest
```

**No API key or network needed** — `backend/test_api.py` monkeypatches the `ai.*` layer (STT/LLM/TTS) and `tools.search_web`, then exercises the real FastAPI app through `TestClient`.

Coverage highlights:

- Contract: `/health`, `/api/chat`, `/api/voice`, `/api/reset` happy paths.
- **Session isolation:** two sessions hold independent histories; reset clears only the target session.
- Validation: empty message (400), empty audio (400), oversized audio (413), blank transcript → `NOTHING_HEARD`.
- Failure mapping: STT exception → `502 STT_FAILED`; TTS exception → `200` with `audio: null`.
- Tool router: query-argument plumbing and unknown-tool handling.

---

## Docker

```bash
docker build -t voice-agent-mvp .
docker run --rm -p 8000:8000 \
  -e OPENAI_API_KEY=sk-… \
  voice-agent-mvp
```

The image (`python:3.12-slim`) copies `backend/` and `frontend/`, installs `backend/requirements.txt`, and starts `uvicorn main:app` on port 8000. Runtime env settings still apply via `-e`.

---

## Deployment

### Option A — Render (recommended, one service)

1. Push this repo to GitHub.
2. Render → **New → Web Service** → pick the repo.
3. **Runtime:** Docker. Render builds from the `Dockerfile`; set the **start command**:
   ```
   uvicorn main:app --host 0.0.0.0 --port $PORT
   ```
4. Add environment variable **`OPENAI_API_KEY`** — use a Render **Secret** (encrypted value).
5. Deploy. Frontend and API ship together on one URL — **no CORS configuration required**.

> Render injects a `$PORT`; uvicorn must bind to it, hence the start command.

### Option B — Any container host

Same as Docker above: expose port 8000, set `OPENAI_API_KEY`. Reverse proxy / TLS are handled at the platform layer.

---

## Security notes

- `OPENAI_API_KEY` exists only server-side (env var / Render secret). It is never sent to the browser and never committed (see `.gitignore`).
- All client input is validated server-side (size, emptiness, duration) — the frontend guards are UX, not the security boundary.
- Tool arguments are JSON-parsed and dispatched by name; unknown tools return an error string and are never executed.
- Prompt-injection surface is **limited but present** — web-search results become tool output that the LLM reads. Current mitigations: results are isolated as a `tool`-role message and the system prompt constrains behavior. Hardening is a roadmap item.
- Traffic should be TLS at the platform level (Render does this by default).
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

The UI visibly signals each stage (`Thinking…`, `Speaking…`) so slow turns don't look frozen. Cutting this latency is exactly what the WebSocket/streaming phase in `distributed_voice_agent_project.md` targets.

---

## Known limitations

- **In-memory state:** conversations are lost on restart/redeploy; no multi-instance sharing. Acceptable for MVP, fatal for scale — Redis is the planned fix.
- **No authentication or rate limiting:** single-tenant demo scope.
- **DuckDuckGo scraping** can be rate-limited or blocked; results are best-effort.
- **No isolation between the push-to-talk requests and server state** beyond the session map — overlapping concurrent requests to the *same* session are not serialized (the frontend enforces single-flight client-side only).
- **Base64 audio in JSON** grows the payload ~33%; fine under 10 MB of transcription audio, wasteful for long clips.

---

## Roadmap

Follows `voice_agent_mvp.md` and then `distributed_voice_agent_project.md`:

1. **Streaming** — WebSocket session, streaming STT/LLM/TTS, partial transcripts.
2. **Persistence** — PostgreSQL (users, sessions, messages, memories) + Redis (session state, rate limiting).
3. **Authentication** — JWT + HTTPS.
4. **WebRTC, VAD, barge-in** — natural interruptions.
5. **Observability** — structured logs, Prometheus/Grafana, latency metrics.
6. **Distributed** — stateless services, Redis pub/sub, connection affinity, horizontal scaling.

First make it work. Then make it fast. Then make it reliable. Then make it scalable.