# Social Work Avatar Lab

Local prototype for social-work interview training with a VRM simulated service user, Cantonese dialogue, retrieval-backed case grounding, and post-session supervision.

This project is a teaching and research prototype. It is not a diagnostic tool, treatment system, crisis service, or official SWRB assessment.

## 中文说明

这是一个本地优先的社工访谈训练原型，用于模拟服务对象访谈，而不是提供诊断、治疗、危机介入或官方社工资格评核。

核心能力：

- 模拟学生社工与服务对象的多轮访谈。
- 使用 DeepSeek 生成服务对象回应，由本地 Python ADK sidecar 统一管理个案状态、检索、安全校准、avatar 指令和访谈后督导。
- 前端使用 React、Three.js、`@pixiv/three-vrm`，支持 John Do ARKit VRM、Streamoji GLB 等 avatar。
- 支持香港口语粤语服务对象回应、香港繁中 UI，也支持英文 UI/回应切换。
- 使用本地 SQLite evidence cards / corpus retrieval， 可选本地 embedding rerank。
- 训练视图默认防剧透，只显示转介摘要和已自然透露的信息；完整个案状态、证据来源、avatar debug 和规则依据只在督导/研究者视图显示。
- 访谈结束后生成督导报告，包含 HK SWRB-aligned practice competency rubric 和雷达图。

本项目的 avatar 行为不是让 LLM 直接控制骨骼或表情。后端只输出语义层的 `avatarDirective`；前端再按坐姿安全、ARKit/VRM 表情模板、Rhubarb lip-sync 和动作规则进行播放。

### 中文快速开始

安装前端依赖：

```bash
npm install
```

安装 ADK sidecar 依赖：

```bash
npm run adk:install
```

在项目根目录创建 `.env.local`：

```bash
DEEPSEEK_API_KEY=your_key_here
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-chat
ADK_SERVICE_PORT=8765
```

启动完整本地服务：

```bash
npm run dev:all
```

打开：

```text
http://127.0.0.1:5173/
```

### 可选：全站账号密码保护

本地或部署环境可以开启简单访问门禁：

```bash
APP_AUTH_ENABLED=true
APP_AUTH_USERNAME=teacher
APP_AUTH_PASSWORD=strong-password
APP_AUTH_SECRET=random-32-byte-secret
```

这会保护整个前端、`/api/*` 和语音 WebSocket。它只是 prototype gate，不是正式多用户 LMS 或角色权限系统。

### 可选：Google 粤语语音

如需粤语 STT/TTS：

```bash
GOOGLE_APPLICATION_CREDENTIALS=/absolute/path/to/service-account.json
GOOGLE_CLOUD_PROJECT=your-project-id
GOOGLE_STT_LANGUAGE=yue-Hant-HK
GOOGLE_TTS_LANGUAGE=yue-HK
GOOGLE_TTS_VOICE=yue-HK-Chirp3-HD-Achird
GOOGLE_VOICE_ENABLED=true
```

如需基于音频的嘴型时间线，可启用 Rhubarb：

```bash
LOCAL_RHUBARB_LIPSYNC_ENABLED=true
RHUBARB_BIN=/absolute/path/to/rhubarb
RHUBARB_RECOGNIZER=phonetic
RHUBARB_TIMEOUT_MS=2500
```

### 中文常用检查

```bash
npm run build
npm run avatar:expression:test
npm run avatar:motion:test
npm run avatar:lip:test
npm run adk:smoke
npm run smoke:sessions
```

### 数据与隐私

以下内容默认应保持本地私有，不应提交或发布：

- `.env.local`
- Google service account JSON
- corpus SQLite / embedding cache
- ADK session store
- 原始或半原始语料
- 访谈 session log、报告、benchmark 输出
- 未确认再分发许可的 VRM/GLB/FBX/avatar 资产

## License

The project source code is released under the MIT License. See [LICENSE](LICENSE).

Third-party assets, avatar models, Mixamo/Streamoji candidates, corpora, Google services, DeepSeek API usage, and generated/private research data may have separate licenses or terms. The MIT License does not override those external rights or data restrictions.

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

### Mixamo motion candidates

Mixamo is treated as a manual review source and optional local runtime overlay, not a required dependency. Download candidate animations yourself from Mixamo and place them under:

```text
public/avatar-clips/_incoming/mixamo/
```

Recommended export settings are FBX/Collada, Without Skin, 30 FPS, and In Place when available. Register and validate a candidate with:

```bash
npm run mixamo:register -- --file public/avatar-clips/_incoming/mixamo/<file>.fbx --family reflective --label "Subtle thinking"
npm run mixamo:validate
npm run mixamo:runtime:test
```

Raw Mixamo clips remain `debug_only`, `autoLoad=false`, and `seatedRuntime=false`. The runtime never plays raw FBX directly on the avatar. If the local ignored manifest and FBX files are present, the frontend samples only upper-body quaternion tracks, ignores hips/root/legs/feet, lowers the motion scale, and blends the result as an idle/speech/reaction overlay. If the files are absent, avatar motion falls back to the built-in seated motion language and procedural idle library.

`mixamo:register` writes a local ignored manifest at `public/avatar-clips/_incoming/mixamo/manifest.local.json`. The tracked `public/avatar-clips/mixamo-manifest.json` remains a clean template so GitHub/Fly builds do not require local FBX files. A local Docker/Fly build can still include the ignored incoming FBX files if they exist in the build context.

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
- Project source code is MIT-licensed; external assets and datasets remain subject to their own terms.
