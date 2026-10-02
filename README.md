# Social Work Avatar Lab

Local prototype for social-work interview training with a VRM simulated service user, Cantonese dialogue, retrieval-backed case grounding, and post-session supervision.

This project is a teaching and research prototype. It is not a diagnostic tool, treatment system, crisis service, or official SWRB assessment.

## 中文说明

### 连续语音与纯台词输出

服务对象文字和 TTS 只使用通过检查的口语台词。动作旁白进入现有一次 LLM repair；仍不合格则返回可重试错误，不写入服务对象回复或推进个案。

切句由后端 `VoiceTurnManager` 统一管理：VAD 结束后等待约 900ms，缺少 final 时使用稳定 partial 并轮换识别流；旧流迟到结果不产生新一轮。麦克风短暂断流最多补两秒静音，持续中断会显示恢复/重新连接，而不会一直假装正在聆听。英文模式的 STT 使用 `en-US`，粤语使用 `yue-Hant-HK`。

离线回归：`npm run voice:boundary:test`、`npm run voice:client:test`、`npm run voice:queue:test`、`npm run client:spoken:test`、`npm run voice:stream:test`。这些测试不调用付费模型。

云端验收需真实麦克风：粤语和英文各连续 10 轮；包含重复说同一句、插话、停止后重开及一次短暂断网。记录重复提交、漏句、恢复状态与延迟；离线测试不能替代这项验收。

这是一个本地优先的社工访谈训练原型，用于模拟服务对象访谈，而不是提供诊断、治疗、危机介入或官方社工资格评核。

核心能力：

- 模拟学生社工与服务对象的多轮访谈。
- 使用 DeepSeek 生成服务对象回应，由本地 Python ADK sidecar 统一管理个案状态、检索、安全校准、avatar 指令和访谈后督导。
- 前端使用 React、Three.js、`@pixiv/three-vrm`，默认使用 John Do ARKit VRM；Streamoji 和 Haru 只在督导工作台中作为对照 avatar。
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

### 可选：全站账号密码和角色保护

本地或部署环境可以开启简单访问门禁：

```bash
APP_AUTH_ENABLED=true
APP_AUTH_USERNAME=teacher
APP_AUTH_PASSWORD=strong-password
APP_AUTH_SECRET=random-32-byte-secret
APP_AUTH_ROLE=instructor
```

多账号部署建议显式设置角色：

```bash
APP_AUTH_USERS_JSON='[{"username":"student01","password":"...","role":"trainee"},{"username":"teacher","password":"...","role":"instructor"}]'
```

这会保护整个前端、`/api/*` 和语音 WebSocket，并在 Node server 端限制 `/instructor`、`/instructor/evidence` 和 Evidence API。它仍是 prototype gate，不是正式 LMS 或用户数据隔离系统。

桌面网页路由：

- `/training`：学生社工训练工作区。
- `/instructor`：受保护的督导/研究者控制台。
- `/instructor/evidence`：受保护的 Evidence Card 审阅页。

### 可选：Google 粤语语音

如需粤语 STT/TTS：

```bash
GOOGLE_APPLICATION_CREDENTIALS=/absolute/path/to/service-account.json
GOOGLE_CLOUD_PROJECT=your-project-id
GOOGLE_STT_LANGUAGE=yue-Hant-HK
GOOGLE_STT_MODEL=google-stt-v1-auto
GOOGLE_TTS_LANGUAGE=yue-HK
GOOGLE_TTS_VOICE=yue-HK-Standard-D
GOOGLE_TTS_MALE_VOICES=yue-HK-Standard-D,yue-HK-Standard-B,yue-HK-Wavenet-D,yue-HK-Wavenet-B,yue-HK-Chirp3-HD-Achird
GOOGLE_TTS_EN_LANGUAGE=en-US
GOOGLE_TTS_EN_VOICE=en-US-Wavenet-D
GOOGLE_TTS_EN_MALE_VOICES=en-US-Wavenet-D,en-US-Neural2-D,en-US-Standard-D,en-US-Chirp3-HD-Charon
GOOGLE_TTS_RATE_VARIATION_ENABLED=true
GOOGLE_VOICE_ENABLED=true
```

语音链路使用内部 realtime v2 生命周期：浏览器优先通过 AudioWorklet 发送 16 kHz mono Int16 binary PCM，服务端以 `utteranceId`、`responseId` 和递增 `sequence` 管理连续识别、去重、恢复与打断。旧版 base64 JSON 音频事件仍保留兼容。默认整段 TTS 继续使用稳定的 Standard-D/Wavenet-D，并由本地 Rhubarb 生成嘴型时间线。

Google Chirp 3 HD streaming TTS 是可选试运行能力，默认关闭：

```bash
GOOGLE_TTS_STREAMING_ENABLED=false
GOOGLE_TTS_STREAMING_YUE_VOICE=yue-HK-Chirp3-HD-Achird
GOOGLE_TTS_STREAMING_EN_VOICE=en-US-Chirp3-HD-Charon
GOOGLE_TTS_STREAMING_SAMPLE_RATE=24000
```

开启后，音频小段会通过同一 WebSocket 逐步返回；如能力检查或调用失败，同一回应只回退一次 Standard TTS。粤语 streaming voice 属预览能力，因此不应直接取代默认路径。

如需基于音频的嘴型时间线，可启用 Rhubarb：

```bash
LOCAL_RHUBARB_LIPSYNC_ENABLED=true
RHUBARB_BIN=/absolute/path/to/rhubarb
RHUBARB_RECOGNIZER=phonetic
RHUBARB_TIMEOUT_MS=2500
```

### 中文常用检查

以下检查不调用付费生成服务：

```bash
npm run build
npm run session:authority:test
npm run session:api:test
npm run auth:boundary:test
npm run voice:machine:test
npm run voice:audio:test
npm run voice:stream:test
npm run voice:tts-stream:test
npm run avatar:expression:test
npm run avatar:motion:test
npm run avatar:lip:test
```

`auth:boundary:test` 使用临时本机端口和假后端；结束后自动清理。`desktop:session:test` 使用已安装的 Chrome 和可选 Playwright（可通过 `PLAYWRIGHT_MODULE` 指定模块路径），验证启动重试、同轮重试、报告失败恢复、切换个案及三个桌面尺寸，不发送真实访谈。

真实模型验收需单独授权：`npm run adk:smoke -- --allow-paid`；不加开关只显示跳过。`npm run smoke:sessions` 仍是收费完整访谈脚本，不属于离线检查，也不应自动进入部署流程。

本轮修复与验收边界见 [可靠性验证记录](docs/reliability-validation.md)。

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

The Fly runtime is cloud-first: the deployed machine runs both the Node web server and the Python ADK sidecar. The browser only captures microphone audio and optionally runs the bundled VAD assets served from `/vad/`; it does not require a local ADK, Rhubarb, corpus, or embedding service.

The Docker image includes Python dependencies, avatar assets, Rhubarb, and the local multilingual embedding model. Corpus and embedding SQLite files are intentionally excluded from the image and must exist on the Fly volume or be restored from private URLs. If embedding is not needed in deployment, set:

```bash
fly secrets set LOCAL_EMBEDDING_ENABLED=false
```

For multiple deployment accounts, set this instead of `APP_AUTH_USERNAME` and `APP_AUTH_PASSWORD`:

```bash
fly secrets set APP_AUTH_USERS_JSON='[{"username":"teacher","password":"...","role":"instructor"},{"username":"student01","password":"...","role":"trainee"}]'
```

For a new Fly volume, configure private restore URLs or upload the SQLite files before serving training traffic:

```bash
fly secrets set CORPUS_SQLITE_RESTORE_URL='https://private.example/corpus.sqlite'
fly secrets set EMBEDDING_SQLITE_RESTORE_URL='https://private.example/embeddings.sqlite'
```

`/api/health` reports `corpusReadiness.status`, manifest version, expected sizes, and whether restore is required. The service may run in an explicit degraded seed mode when the required corpus is absent.

Accounts may be assigned `trainee` or `instructor` roles. Instructor routes and APIs are checked by the server; the in-app display mode alone does not grant instructor access. Accounts still share the prototype's training data and are not isolated into per-user workspaces.

## Optional Google Voice

For Cantonese speech input/output, add Google credentials and enable voice:

```bash
GOOGLE_APPLICATION_CREDENTIALS=/absolute/path/to/service-account.json
GOOGLE_CLOUD_PROJECT=your-project-id
GOOGLE_STT_LANGUAGE=yue-Hant-HK
GOOGLE_STT_MODEL=google-stt-v1-auto
GOOGLE_TTS_LANGUAGE=yue-HK
GOOGLE_TTS_VOICE=yue-HK-Standard-D
GOOGLE_TTS_MALE_VOICES=yue-HK-Standard-D,yue-HK-Standard-B,yue-HK-Wavenet-D,yue-HK-Wavenet-B,yue-HK-Chirp3-HD-Achird
GOOGLE_TTS_EN_LANGUAGE=en-US
GOOGLE_TTS_EN_VOICE=en-US-Wavenet-D
GOOGLE_TTS_EN_MALE_VOICES=en-US-Wavenet-D,en-US-Neural2-D,en-US-Standard-D,en-US-Chirp3-HD-Charon
GOOGLE_TTS_RATE_VARIATION_ENABLED=true
GOOGLE_VOICE_ENABLED=true
```

The browser and sidecar negotiate the internal realtime voice protocol v2. AudioWorklet sends 16 kHz mono Int16 binary PCM; ordered `utteranceId`, `responseId`, and `sequence` fields prevent stale recognition events from replacing a newer utterance. The stable default remains whole-response Standard-D/Wavenet-D audio with Rhubarb lip-sync.

Optional Chirp 3 HD streaming TTS is feature-flagged and disabled by default:

```bash
GOOGLE_TTS_STREAMING_ENABLED=false
GOOGLE_TTS_STREAMING_YUE_VOICE=yue-HK-Chirp3-HD-Achird
GOOGLE_TTS_STREAMING_EN_VOICE=en-US-Chirp3-HD-Charon
GOOGLE_TTS_STREAMING_SAMPLE_RATE=24000
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

## Cloud Readiness Checks

The production build copies browser VAD assets from `node_modules` into `public/vad/` before Vite builds. These generated assets are ignored by git and are included in the Fly image through `npm run build`.

Non-spending cloud checks:

```bash
npm run cloud:health:test
npm run cloud:voice:manual-check
```

`cloud:health:test` verifies that the Fly site is online and protected by Basic Auth. To also check authenticated `/api/health`, pass credentials only through the environment:

```bash
CLOUD_HEALTH_BASIC_AUTH='teacher:strong-password' npm run cloud:health:test
```

The manual voice checklist does not call DeepSeek or Google APIs; it prints the browser smoke steps for Cantonese voice, barge-in, TTS, and avatar behavior.

## Key Scripts

Run checks:

```bash
npm run build
npm run session:authority:test
npm run session:api:test
npm run auth:boundary:test
npm run voice:machine:test
npm run voice:audio:test
npm run voice:stream:test
npm run voice:tts-stream:test
```

These checks use local fixtures/provider mocks. Optional `npm run desktop:session:test` needs Chrome and Playwright (`PLAYWRIGHT_MODULE` can point to an existing installation). Live ADK smoke requires explicit `npm run adk:smoke -- --allow-paid`; `smoke:sessions` also calls paid providers and must not run automatically during deployment. See the [validation record](docs/reliability-validation.md) for verified scope and remaining acceptance work.

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

The avatar is driven by semantic directives, not raw LLM bone control. John Do ARKit VRM is the default avatar and stable quality baseline. Streamoji GLB remains available to instructors and uses a generic humanoid seated adapter plus ARKit expression control. The frontend maps affect, motion cue, case baseline, and performance plan into seated upper-body motion with idle-first micro movement and stronger reactions only for rupture/risk/emotion-shift moments.

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
# PatientAct-inspired reaction planning / 反應規劃

`CLIENT_REACTION_PLAN_ENABLED=false` is the default. Set it on the **server** to
enable a single completion containing a compact `reactionPlan` and spoken dialogue.
This is inspired by [PatientAct](https://arxiv.org/html/2608.12750v2), not a reproduction
of its independent reaction/behavior pipeline or a clinically validated assessment.

新路徑使用五個現有個案的 fact ID、主題及透露級別白名單；未知 fact 預設不解鎖。
完整 persona、事件及 grounding 不再直接進入此路徑的生成／repair prompt，避免繞過透露限制。
改用轉介摘要、抽象個案邏輯、已允許資料與本次訪談歷史。計劃只是意圖，不會自動標記 revealedFacts。
這是有意的保守邊界，可能減少個案細節，必須做人工比較而非假定真實度必然提高。

The existing single repair budget also covers plan/schema, spoken-text and safety
errors. Invalid repaired responses fail before case-state updates and TTS; no canned
dialogue replacement is used in the enabled path. Instructor responses include the
plan and validation, while trainee HTTP/WebSocket serialization removes them.
Node overwrites the role header after authentication; ADK must remain private/loopback,
not exposed directly to the Internet. This is not per-user session ownership.

- Offline regression: `npm run client:reaction:test` (no provider calls).
- Explicit paid comparison: `npm run evaluate:reaction -- --allow-paid` (80 synthetic
  turns, plus at most one repair per turn; no Google TTS). Reports are private under
  `data/reports/reaction-plans/`, with isolated temporary evaluation session storage.
- Enable on Fly only after tests, paid comparison and human review: no more repetition
  or empty avoidance, no loss of continuity/topic specificity, and p95 latency increase
  no greater than 15%. The small benchmark is a regression check, not scientific validation.
- Roll back by setting `CLIENT_REACTION_PLAN_ENABLED=false`. Existing training records
  remain intact; no corpus rebuild or cross-session memory is introduced.

# ADK Runner execution / ADK Runner 呼叫路徑

Model execution remains on the existing direct DeepSeek HTTP path by default.
`ADK_LLM_EXECUTION_ENABLED=true` opts the server into one ephemeral Google ADK
`Runner` invocation per structured completion. It does not persist model history,
and a failed Runner call is returned as an error rather than retried through direct
HTTP (avoiding duplicate provider charges). Keep the flag off until the explicit
provider-backed comparison and cancellation review are approved.

預設仍使用現有 DeepSeek 直連。只有在服務端設定
`ADK_LLM_EXECUTION_ENABLED=true` 才會改由 ADK `Runner` 執行單次結構化呼叫；
不保存跨回合模型記憶，失敗亦不會自動改走直連重試。未完成付費對照及取消行為
驗收前，請保持關閉。
