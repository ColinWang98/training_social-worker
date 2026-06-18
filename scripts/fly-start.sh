#!/usr/bin/env bash
set -euo pipefail

cd /app

export PATH="/opt/venv/bin:${PATH}"
export ADK_SERVICE_HOST="${ADK_SERVICE_HOST:-127.0.0.1}"
export ADK_SERVICE_PORT="${ADK_SERVICE_PORT:-8765}"
export ADK_SERVICE_URL="${ADK_SERVICE_URL:-http://127.0.0.1:${ADK_SERVICE_PORT}}"
export HOST="${HOST:-0.0.0.0}"
export PORT="${PORT:-8080}"

mkdir -p /app/secrets

if [[ -n "${GOOGLE_APPLICATION_CREDENTIALS_JSON_BASE64:-}" ]]; then
  python - <<'PY'
import base64
import os
from pathlib import Path

target = Path("/app/secrets/google-service-account.json")
target.write_bytes(base64.b64decode(os.environ["GOOGLE_APPLICATION_CREDENTIALS_JSON_BASE64"]))
os.chmod(target, 0o600)
PY
  export GOOGLE_APPLICATION_CREDENTIALS="/app/secrets/google-service-account.json"
elif [[ -n "${GOOGLE_APPLICATION_CREDENTIALS_JSON:-}" ]]; then
  python - <<'PY'
import os
from pathlib import Path

target = Path("/app/secrets/google-service-account.json")
target.write_text(os.environ["GOOGLE_APPLICATION_CREDENTIALS_JSON"], encoding="utf-8")
os.chmod(target, 0o600)
PY
  export GOOGLE_APPLICATION_CREDENTIALS="/app/secrets/google-service-account.json"
fi

if [[ -d /data ]]; then
  mkdir -p /data/corpus /data/adk /data/profiles
  if [[ ! -f /data/.social-work-data-initialized ]]; then
    cp -a /app/data/. /data/ 2>/dev/null || true
    touch /data/.social-work-data-initialized
  fi
  rm -rf /app/data
  ln -s /data /app/data
fi

python -m uvicorn adk_service.main:app \
  --host "${ADK_SERVICE_HOST}" \
  --port "${ADK_SERVICE_PORT}" &
ADK_PID=$!

node server.mjs &
APP_PID=$!

shutdown() {
  kill "${APP_PID}" "${ADK_PID}" 2>/dev/null || true
  wait "${APP_PID}" "${ADK_PID}" 2>/dev/null || true
}

trap shutdown INT TERM

wait -n "${APP_PID}" "${ADK_PID}"
EXIT_CODE=$?
shutdown
exit "${EXIT_CODE}"
