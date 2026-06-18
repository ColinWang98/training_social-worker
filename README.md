# Social Work Avatar Lab

Local prototype for social-work interview training with a VRM simulated service user, Cantonese dialogue, retrieval-backed case grounding, and post-session supervision.

This project is a teaching and research prototype. It is not a diagnostic tool, treatment system, crisis service, or official SWRB assessment.

## What It Does

- Simulates service-user interviews for social-work training.
- Uses DeepSeek through a local Python ADK sidecar for client responses and post-session review.
- Uses a React + Three.js + `@pixiv/three-vrm` frontend for the avatar.
- Supports Hong Kong spoken Cantonese client replies and Hong Kong Traditional Chinese UI/supervision.
- Uses local SQLite corpus retrieval, optional local embedding rerank, and evidence-card summaries.
- Keeps trainee view spoiler-safe: hidden facts, raw evidence cards, full state, and debug signals are only shown in instructor mode.
- Generates post-session supervision reports with an HK SWRB-aligned practice competency rubric and radar chart.

## Architecture

```text
React/Vite frontend
  - interview UI
  - VRM avatar runtime
  - trainee/instructor views
  - optional Google voice controls

Node server.mjs
  - Vite dev server
  - local API/WebSocket proxy
  - no domain fallback simulation

Python ADK sidecar
  - SocialWorkCoordinatorAgent
  - DeepSeek client simulation
  - evidence retrieval
  - adaptive response policy
  - realism/safety calibration
  - avatar directive policy
  - post-session supervisor report

Local data
  - data/corpus/*.sqlite
  - data/corpus/*.jsonl
  - data/adk/*.sqlite
  - data/profiles/<case>/active.json
```

## Quick Start

Install frontend dependencies:

```bash
npm install
```

Install the ADK sidecar dependencies:

```bash
npm run adk:install
```

Create `.env.local` in the project root:

```bash
DEEPSEEK_API_KEY=your_key_here
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-chat
ADK_SERVICE_PORT=8765
```

Optional local access gate:

```bash
APP_AUTH_ENABLED=true
APP_AUTH_USERNAME=teacher
APP_AUTH_PASSWORD=strong-password
APP_AUTH_SECRET=random-32-byte-secret
```

When enabled, the Node server protects the whole app, `/api/*`, and the voice WebSocket with HTTP Basic Auth plus a signed HttpOnly cookie. This is a prototype access gate, not a full multi-user learning-management login system.

Run the full local stack:

```bash
npm run dev:all
```

Open:

```text
http://127.0.0.1:5173/
```

## Docker and Fly.io Deployment

The repository includes a full Docker image path for the complete stack:

- production React build
- Node production server and API/WebSocket proxy
- Python ADK sidecar
- SQLite corpus/session data
- local embedding model cache
- VRM/avatar assets
- Google STT/TTS support through secrets

Build locally:

```bash
docker build -t social-work-avatar-lab:full .
```

Run locally with Docker:

```bash
docker run --rm -p 8080:8080 \
  -e DEEPSEEK_API_KEY=your_key_here \
  -e APP_AUTH_ENABLED=true \
  -e APP_AUTH_USERNAME=teacher \
  -e APP_AUTH_PASSWORD=strong-password \
  -e APP_AUTH_SECRET=random-32-byte-secret \
  -e GOOGLE_VOICE_ENABLED=true \
  -e GOOGLE_APPLICATION_CREDENTIALS_JSON_BASE64="$(base64 -i /absolute/path/to/service-account.json)" \
  social-work-avatar-lab:full
```

Open:

```text
http://127.0.0.1:8080/
```

Deploy to Fly.io:

```bash
fly launch --no-deploy
fly volumes create social_work_data --size 3 --region sin
fly secrets set DEEPSEEK_API_KEY=your_key_here
fly secrets set APP_AUTH_USERNAME=teacher
fly secrets set APP_AUTH_PASSWORD='strong-password'
fly secrets set APP_AUTH_SECRET="$(openssl rand -hex 32)"
fly secrets set GOOGLE_APPLICATION_CREDENTIALS_JSON_BASE64="$(base64 -i /absolute/path/to/service-account.json)"
fly deploy
```

The included `fly.toml` uses:

- app name: `training-social-worker`
- region: `sin`
- web port: `8080`
- internal ADK port: `8765`
- volume mount: `/data`
- VM: 2 shared CPUs, 4096 MB memory
- full-site access gate: enabled with username/password secrets

The first start copies bundled `data/` into the mounted `/data` volume, then uses `/data` as the writable runtime store. API keys and Google service-account JSON must be provided through Fly secrets, not committed files.

The Docker image is intentionally large because it includes Python dependencies, corpus files, avatar assets, and the local multilingual embedding model. If embedding is not needed in deployment, set:

```bash
fly secrets set LOCAL_EMBEDDING_ENABLED=false
```

For multiple deployment accounts, set this instead of `APP_AUTH_USERNAME` and `APP_AUTH_PASSWORD`:

```bash
fly secrets set APP_AUTH_USERS_JSON='[{"username":"teacher","password":"..."},{"username":"student01","password":"..."}]'
```

Anyone with a valid password can access the same prototype. The in-app trainee/instructor toggle is still a UI mode, not role-based authorization.

## Optional Google Voice

For Cantonese speech input/output, add Google credentials and enable voice:

```bash
GOOGLE_APPLICATION_CREDENTIALS=/absolute/path/to/service-account.json
GOOGLE_CLOUD_PROJECT=your-project-id
GOOGLE_STT_LANGUAGE=yue-Hant-HK
GOOGLE_TTS_LANGUAGE=yue-HK
GOOGLE_TTS_VOICE=yue-HK-Chirp3-HD-Achird
GOOGLE_VOICE_ENABLED=true
```

For audio-aligned mouth movement, enable local Rhubarb lip-sync. Docker/Fly builds install Rhubarb at `/opt/rhubarb/rhubarb`; local development can use any downloaded Rhubarb binary:

```bash
LOCAL_RHUBARB_LIPSYNC_ENABLED=true
RHUBARB_BIN=/absolute/path/to/rhubarb
RHUBARB_RECOGNIZER=phonetic
RHUBARB_TIMEOUT_MS=2500
```

If Rhubarb is missing or fails, TTS still works and the avatar falls back to the built-in text-based viseme timeline.

Credentials must stay local and must not be committed.

## Key Scripts

Run checks:

```bash
npm run build
npm run adk:smoke
npm run smoke:sessions
```

Corpus:

```bash
npm run corpus:preflight
npm run corpus:build -- --sample=20
npm run corpus:stats
npm run corpus:export:balanced
```

Local embedding cache:

```bash
npm run corpus:embed
npm run corpus:embed:stats
npm run evaluate:retrieval
```

Profiles:

```bash
npm run profile:generate -- --from-case-spec --case student_depression_bullying
npm run profile:generate -- --synthetic-interview --case student_depression_bullying
npm run profile:adapt -- --case student_depression_bullying --method adaptive_vp
```

Sessions and benchmarks:

```bash
npm run session:export -- --session-id <session-id>
npm run session:replay -- --input data/session-logs/<session-id>.json
npm run benchmark:methods
```

Avatar assets:

```bash
npm run vrm:inspect -- public/models/client-john-do-arkit.vrm
npm run vrma:download
npm run vrma:validate
```

## Simulation Flow

Each student message is processed as:

```text
student text
  -> student move analysis
  -> session continuity lookup
  -> adaptive response policy
  -> evidence-card retrieval
  -> grounding profile + PIE context
  -> DeepSeek client response
  -> realism and safety calibration
  -> case state update
  -> avatar directive
  -> session trace persistence
```

The avatar is driven by semantic directives, not raw LLM bone control. The frontend maps affect, motion cue, case baseline, and performance plan into seated upper-body VRM motion.

## Evidence Cards

Evidence cards are normalized examples of service-user language, issue tags, affect, risk signals, resistance patterns, and disclosure depth. Runtime retrieval uses them as style and reaction-pattern grounding.

Evidence cards are not shown to trainees. Instructor mode only shows compact source/tag summaries unless using the evidence-card viewer for local review.

## Profiles and PIE Framing

Grounding profiles live under:

```text
data/profiles/<caseType>/active.json
```

Profiles include:

- self-report grounding
- life and relationship context
- avoidance patterns
- speech style
- case reflections
- Person-in-Environment framing
- micro, meso, and macro context
- disclosure development rules

The runtime loads the active profile when available. If no profile exists, it falls back to the case spec.

## Data and Privacy

Local generated data is private by default:

- corpus SQLite databases
- embedding caches
- ADK session stores
- profile outputs
- reports and benchmark outputs
- service account JSON files
- `.env.local`

Do not publish raw corpus text, private session logs, API keys, or Google credentials.

## Notes

- Node is only the local app/proxy runtime.
- Python ADK sidecar owns the domain simulation workflow.
- SQLite is the local source of truth for corpus/session data.
- Optional Supabase import exists for database experiments, but the default prototype is local-first.
- HK PCF output is a training rubric aligned with local practice concepts. It is not an official SWRB certification or registration assessment.
