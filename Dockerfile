FROM node:20-bookworm-slim AS web-build

WORKDIR /app
COPY package*.json ./
RUN npm ci

COPY index.html tsconfig.json vite.config.ts ./
COPY src ./src
COPY public ./public
RUN npm run build


FROM node:20-bookworm-slim AS runtime

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    ADK_SERVICE_HOST=127.0.0.1 \
    ADK_SERVICE_PORT=8765 \
    ADK_SERVICE_URL=http://127.0.0.1:8765 \
    LOCAL_EMBEDDING_ENABLED=true \
    LOCAL_EMBEDDING_MODEL=sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2 \
    LOCAL_EMBEDDING_DEVICE=cpu \
    LOCAL_EMBEDDING_BATCH_SIZE=64 \
    LOCAL_RHUBARB_LIPSYNC_ENABLED=true \
    RHUBARB_BIN=/opt/rhubarb/rhubarb \
    RHUBARB_RECOGNIZER=phonetic \
    RHUBARB_TIMEOUT_MS=2500 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-venv python3-pip build-essential ca-certificates curl unzip \
  && rm -rf /var/lib/apt/lists/*

ARG RHUBARB_VERSION=1.13.0
RUN mkdir -p /opt/rhubarb \
  && curl -fsSL "https://github.com/DanielSWolf/rhubarb-lip-sync/releases/download/v${RHUBARB_VERSION}/rhubarb-lip-sync-${RHUBARB_VERSION}-linux.zip" -o /tmp/rhubarb.zip \
  && unzip -q /tmp/rhubarb.zip -d /tmp/rhubarb \
  && find /tmp/rhubarb -type f -name rhubarb -exec cp {} /opt/rhubarb/rhubarb \; \
  && chmod +x /opt/rhubarb/rhubarb \
  && rm -rf /tmp/rhubarb /tmp/rhubarb.zip

COPY adk_service/requirements.txt ./adk_service/requirements.txt
RUN python3 -m venv /opt/venv \
  && /opt/venv/bin/pip install --upgrade pip \
  && /opt/venv/bin/pip install -r adk_service/requirements.txt

# Keep the local embedding model available without runtime downloads.
RUN /opt/venv/bin/python -c "from sentence_transformers import SentenceTransformer; SentenceTransformer('sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2')"

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=web-build /app/dist ./dist
COPY server.mjs ./
COPY adk_service ./adk_service
COPY scripts ./scripts
COPY data ./data
COPY public ./public
COPY README.md ./

RUN chmod +x scripts/fly-start.sh

EXPOSE 8080
CMD ["scripts/fly-start.sh"]
