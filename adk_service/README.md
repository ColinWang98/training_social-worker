# ADK Service

Local Python sidecar for the social-work client simulator.

## Run

```bash
python3 -m venv .venv-adk
.venv-adk/bin/pip install -r adk_service/requirements.txt
.venv-adk/bin/python -m uvicorn adk_service.main:app --host 127.0.0.1 --port 8765
```

The Node dev server proxies `/api/*` to `ADK_SERVICE_URL`, defaulting to
`http://127.0.0.1:8765`.

## Env

The service reads `.env.local` first, then `adk_service/.env` if present.

```bash
DEEPSEEK_API_KEY=...
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-chat
ADK_SERVICE_PORT=8765
```

## Supabase Postgres

Optional. If `SUPABASE_DATABASE_URL` is set, ADK sessions and evidence-card
loading use Supabase Postgres. If it is missing, the service keeps using local
SQLite/JSONL files.

Use the Supabase pooled Postgres connection string for the app runtime.

```bash
SUPABASE_DATABASE_URL=postgresql://postgres.xxx:...@aws-...pooler.supabase.com:6543/postgres
SUPABASE_POOL_SIZE=4
```

Setup:

1. Run `supabase/migrations/001_social_work_corpus.sql` in the Supabase SQL editor or through the Supabase CLI.
2. Reinstall ADK deps after this change:

```bash
.venv-adk/bin/pip install -r adk_service/requirements.txt
```

3. Import the local corpus SQLite into Supabase:

```bash
npm run supabase:import
```

The migration enables RLS and denies client-role access to corpus/session tables.
The frontend should never receive the Supabase service key or direct database URL.
