# ---- build stage ----
FROM node:22.23.5-bookworm-slim AS build
WORKDIR /app

# CI-friendly env
ENV HUSKY=0
ENV CI=true

# Use pnpm
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate

# Ensure git is available for build and runtime scripts
RUN apt-get update && apt-get install -y --no-install-recommends git \
  && rm -rf /var/lib/apt/lists/*

# Accept (optional) build-time public URL for Remix/Vite (Coolify can pass it)
ARG VITE_PUBLIC_APP_URL
ENV VITE_PUBLIC_APP_URL=${VITE_PUBLIC_APP_URL}

# Install deps efficiently
COPY package.json pnpm-lock.yaml* ./
RUN pnpm fetch

# Copy source and build
COPY . .
# install with dev deps (needed to build)
RUN pnpm install --offline --frozen-lockfile

# Build the Remix app (SSR + client)
RUN NODE_OPTIONS=--max-old-space-size=4096 pnpm run build

# ---- production stage ----
# Vite preview loads vite.config.ts and its plugins at runtime, so it needs the
# build dependencies as well as the production dependencies.
FROM build AS bolt-ai-production
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=5173
ENV HOST=0.0.0.0

# Non-sensitive build arguments
ARG VITE_LOG_LEVEL=debug
ARG DEFAULT_NUM_CTX

# Set non-sensitive environment variables
ENV WRANGLER_SEND_METRICS=false \
    VITE_LOG_LEVEL=${VITE_LOG_LEVEL} \
    DEFAULT_NUM_CTX=${DEFAULT_NUM_CTX} \
    RUNNING_IN_DOCKER=true

# Note: API keys should be provided at runtime via docker run -e or docker-compose
# Example: docker run -e OPENAI_API_KEY=your_key_here ...

# Install curl for healthchecks
RUN apt-get update && apt-get install -y --no-install-recommends curl \
  && rm -rf /var/lib/apt/lists/*

# Pre-configure wrangler to disable metrics
RUN mkdir -p /root/.config/.wrangler && \
    echo '{"enabled":false}' > /root/.config/.wrangler/metrics.json

EXPOSE 5173

# Healthcheck for deployment platforms
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
  CMD curl -fsS http://localhost:5173/ || exit 1

# Start the built app with Vite's Cloudflare preview server
CMD ["pnpm", "run", "dockerstart"]


# ---- development stage ----
FROM build AS development

# Non-sensitive development arguments
ARG VITE_LOG_LEVEL=debug
ARG DEFAULT_NUM_CTX

# Set non-sensitive environment variables for development
ENV VITE_LOG_LEVEL=${VITE_LOG_LEVEL} \
    DEFAULT_NUM_CTX=${DEFAULT_NUM_CTX} \
    RUNNING_IN_DOCKER=true

# Note: API keys should be provided at runtime via docker run -e or docker-compose
# Example: docker run -e OPENAI_API_KEY=your_key_here ...

RUN mkdir -p /app/run
CMD ["pnpm", "run", "dev", "--host"]


# ---- Node server (Shipholm and any plain container host) ----
# The last stage, so a plain `docker build .` – which is what Shipholm's build service runs –
# produces it. Runs the Worker build on Node (server.mjs) as a non-root user and writes nothing
# to disk, so it works on a read-only root filesystem. API keys come from the environment.
FROM build AS prod-deps
RUN pnpm prune --prod --ignore-scripts

FROM node:22.23.5-bookworm-slim AS node-server
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/build ./build
COPY --from=build /app/package.json /app/server.mjs /app/shipholm.mjs ./
USER 10001:10001
EXPOSE 8080
CMD ["node", "server.mjs"]
