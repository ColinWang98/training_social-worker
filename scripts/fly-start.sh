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
  if [[ ! -f /data/.social-work-data-initialized && -f /app/data/corpus/social-work-client-corpus.sqlite ]]; then
    cp -a /app/data/. /data/ 2>/dev/null || true
    touch /data/.social-work-data-initialized
  fi
  if [[ ! -f /data/corpus/social-work-client-corpus.sqlite && -n "${CORPUS_SQLITE_RESTORE_URL:-}" ]]; then
    echo "[fly-start] Restoring corpus SQLite from configured private URL."
    curl -fL --retry 3 "${CORPUS_SQLITE_RESTORE_URL}" -o /data/corpus/social-work-client-corpus.sqlite.tmp
    mv /data/corpus/social-work-client-corpus.sqlite.tmp /data/corpus/social-work-client-corpus.sqlite
  fi
  if [[ ! -f /data/corpus/social-work-client-embeddings.sqlite && -n "${EMBEDDING_SQLITE_RESTORE_URL:-}" ]]; then
    echo "[fly-start] Restoring embedding SQLite from configured private URL."
    curl -fL --retry 3 "${EMBEDDING_SQLITE_RESTORE_URL}" -o /data/corpus/social-work-client-embeddings.sqlite.tmp
    mv /data/corpus/social-work-client-embeddings.sqlite.tmp /data/corpus/social-work-client-embeddings.sqlite
  fi
  if [[ -f /app/data/corpus/corpus-manifest.json ]]; then
    cp /app/data/corpus/corpus-manifest.json /data/corpus/corpus-manifest.json
  fi
  rm -rf /app/data
  ln -s /data /app/data
fi

echo "[fly-start] Node server target: ${HOST}:${PORT}"
echo "[fly-start] ADK service target: ${ADK_SERVICE_HOST}:${ADK_SERVICE_PORT}"
echo "[fly-start] Google voice enabled: ${GOOGLE_VOICE_ENABLED:-false}"
echo "[fly-start] Voice protocol: realtime-v2 (binary PCM preferred)"
echo "[fly-start] Streaming TTS enabled: ${GOOGLE_TTS_STREAMING_ENABLED:-false}"
echo "[fly-start] Google credentials detected: $([[ -n "${GOOGLE_APPLICATION_CREDENTIALS:-}" ]] && echo true || echo false)"
echo "[fly-start] Rhubarb binary: ${RHUBARB_BIN:-not-set} $([[ -x "${RHUBARB_BIN:-}" ]] && echo available || echo unavailable)"
echo "[fly-start] Corpus path: $(readlink -f /app/data 2>/dev/null || echo /app/data)"
if [[ -f /app/data/corpus/social-work-client-corpus.sqlite ]]; then
  echo "[fly-start] Corpus readiness: ready"
else
  echo "[fly-start] Corpus readiness: degraded (restore required; runtime will use seed fallback)"
fi

node server.mjs &
APP_PID=$!

python -m uvicorn adk_service.main:app \
  --host "${ADK_SERVICE_HOST}" \
  --port "${ADK_SERVICE_PORT}" &
ADK_PID=$!

shutdown() {
  kill "${APP_PID}" "${ADK_PID}" 2>/dev/null || true
  wait "${APP_PID}" "${ADK_PID}" 2>/dev/null || true
}

trap shutdown INT TERM

wait -n "${APP_PID}" "${ADK_PID}"
EXIT_CODE=$?
shutdown
exit "${EXIT_CODE}"
