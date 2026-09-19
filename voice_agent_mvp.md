# Voice Agent — MVP

## Goal

Build a simple, deployable AI voice agent that lets a user:

1. Speak through a browser.
2. Convert speech to text.
3. Send the text to an LLM.
4. Get an intelligent response.
5. Convert the response to speech.
6. Hear the response in the browser.

For the MVP, **do not build a distributed system**. Focus on making the complete voice → AI → voice loop reliable and deployable.

## Architecture

```text
USER
  │
Microphone
  │
  ▼
Browser Frontend
HTML/CSS/JavaScript
  │
  │ HTTP
  ▼
FastAPI Backend
  │
  ├── Speech-to-Text
  │
  ├── LLM
  │
  └── Text-to-Speech
          │
          ▼
       Browser
          │
        Speaker
```

## Tech Stack

### Frontend
- HTML
- CSS
- JavaScript
- Browser MediaRecorder / getUserMedia APIs

React is optional later. It is not required for the first prototype.

### Backend
- Python
- FastAPI

Responsibilities:
- Receive audio
- Call STT
- Send text to LLM
- Call TTS
- Return response/audio
- Handle basic errors

### AI
Use one provider initially:
- Speech-to-text
- LLM
- Text-to-speech

Keep the implementation simple; do not build provider abstractions yet.

### Deployment
- Frontend: Vercel or static hosting
- Backend: Render, Railway, or Fly.io

---

## Essential Features

### 1. Push-to-Talk

User clicks:

```text
🎙️ Start Talking
```

Speaks, then clicks:

```text
⏹ Stop
```

The audio is sent to the backend.

### 2. Speech-to-Text

```text
Audio → Text
```

Example:

> Explain what a process is in Linux.

Show the transcript in the UI.

### 3. LLM Response

Send the transcript to the LLM.

Example:

```text
User:
Explain what a process is in Linux.

Agent:
A process is a running instance of a program...
```

### 4. Text-to-Speech

```text
LLM response
     ↓
    TTS
     ↓
   Audio
```

Play the generated audio automatically.

### 5. Basic Conversation History

Display:

```text
You: What is a process?

Agent: A process is...

You: How is it different from a thread?

Agent: ...
```

Keep history in memory for now. No database.

### 6. Reset Conversation

Add:

```text
[ New Conversation ]
```

### 7. Basic Error Handling

Handle:
- Microphone permission denied
- Empty audio
- STT failure
- LLM failure
- TTS failure
- Network failure
- Invalid API key

---

## User Flow

```text
Open website
     ↓
Click Start Talking
     ↓
Speak
     ↓
Click Stop
     ↓
Audio uploaded
     ↓
STT
     ↓
Transcript displayed
     ↓
LLM
     ↓
Response displayed
     ↓
TTS
     ↓
Audio plays
     ↓
User speaks again
```

---

## Minimal API

### Health

```http
GET /health
```

Response:

```json
{"status": "ok"}
```

### Voice

```http
POST /api/voice
```

Input:
- audio file
- conversation history

Backend:

```text
audio
 ↓
STT
 ↓
LLM
 ↓
TTS
```

### Reset

```http
POST /api/reset
```

Clears the current conversation.

---

## Project Structure

```text
voice-agent/
│
├── backend/
│   ├── main.py
│   ├── config.py
│   ├── ai.py
│   ├── conversation.py
│   └── requirements.txt
│
├── frontend/
│   ├── index.html
│   ├── style.css
│   └── app.js
│
├── .env
├── .env.example
├── .gitignore
├── Dockerfile
└── README.md
```

Keep the structure small. Do not create a complex architecture for the MVP.

---

## Backend Responsibilities

### `main.py`

FastAPI application and endpoints:

```text
/api/voice
/api/reset
/health
```

### `ai.py`

Contains:

```text
speech_to_text()
generate_response()
text_to_speech()
```

### `conversation.py`

Maintains the current conversation:

```python
conversation = [
    {
        "role": "system",
        "content": "You are a helpful voice assistant."
    }
]
```

### `config.py`

Loads environment variables such as:

```text
OPENAI_API_KEY
```

---

## Frontend

Keep the UI simple:

```text
┌──────────────────────────────────────┐
│          AI VOICE AGENT              │
│                                      │
│  You:                                │
│  Explain virtual memory.             │
│                                      │
│  Agent:                              │
│  Virtual memory is...                │
│                                      │
│       🎙️ [ Start Talking ]          │
│                                      │
│       [ New Conversation ]           │
│                                      │
│  Status: Ready                       │
└──────────────────────────────────────┘
```

Do not spend days on frontend design.

---

## Conversation State

For MVP, keep conversation state in memory.

```text
User message
     ↓
Append to conversation
     ↓
LLM
     ↓
Append assistant response
```

Example:

```python
conversation = [
    {"role": "system", "content": "..."},
    {"role": "user", "content": "What is TCP?"},
    {"role": "assistant", "content": "TCP is..."},
    {"role": "user", "content": "How is it different from UDP?"}
]
```

---

## One Agent Tool

After the basic voice loop works, add only **one tool**:

### Web Search

Example:

```text
User:
Search the web and tell me about the latest PostgreSQL release.

        ↓
STT
        ↓
LLM
        ↓
search_web()
        ↓
Search results
        ↓
LLM summarizes
        ↓
TTS
        ↓
Agent speaks
```

This is enough to demonstrate basic agent/tool-calling behavior.

---

## Explicitly Out of Scope

Do **not** build these in the MVP:

```text
❌ WebRTC
❌ Redis
❌ PostgreSQL
❌ Kubernetes
❌ Microservices
❌ Multiple agents
❌ Long-term memory
❌ Authentication
❌ Prometheus/Grafana
❌ Complex tool framework
❌ Phone calling
❌ Vector database
❌ RAG
❌ Event queues
```

These can become future upgrades.

---

## Build Roadmap

### Milestone 1 — Text Agent

```text
FastAPI → LLM → Response
```

### Milestone 2 — STT

```text
Audio → STT → Text
```

### Milestone 3 — TTS

```text
Text → TTS → Audio
```

### Milestone 4 — Complete Voice Loop

```text
Microphone
    ↓
STT
    ↓
LLM
    ↓
TTS
    ↓
Speaker
```

This is the first working MVP.

### Milestone 5 — Conversation

Add:
- Conversation history
- Reset button

### Milestone 6 — One Tool

Add:
- Web search

### Milestone 7 — Deploy

Deploy the frontend and backend and configure the API key server-side.

---

## Definition of Done

The MVP is finished when a user can:

```text
1. Open the deployed website
2. Click microphone
3. Speak naturally
4. See their transcript
5. Receive an AI response
6. Hear the response
7. Ask a follow-up question
8. Preserve conversation context
9. Reset the conversation
10. Use one agent tool
```

If these work reliably, **stop building the MVP**.

---

## Future Evolution

Only after the MVP works:

```text
MVP
 │
 ├── Streaming
 ├── WebRTC
 ├── Redis
 ├── PostgreSQL
 ├── Authentication
 ├── Long-term memory
 ├── More tools
 ├── Observability
 └── Horizontal scaling
```

Build in this order:

> **First make it work. Then make it fast. Then make it reliable. Then make it scalable.**

---

## Final MVP Stack

```text
Frontend
└── HTML + CSS + JavaScript

Backend
└── Python + FastAPI

AI
├── Speech-to-Text
├── LLM
└── Text-to-Speech

Agent Tool
└── Web Search

Deployment
├── Vercel / Static hosting
└── Render / Railway / Fly.io

Storage
└── None

Database
└── None

Cache
└── None
```

## One-Line Project Description

> A browser-based AI voice assistant built with JavaScript and FastAPI that listens to the user, uses an LLM to reason about requests, optionally calls a web-search tool, and speaks the answer back.
