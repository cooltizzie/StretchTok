# Node base image + real ffmpeg installed via apt — this is the whole reason
# we need a container at all: Render/Railway/etc's non-Docker "just detect my
# language" paths don't give you a native ffmpeg binary, only Docker does.
FROM node:20-slim

# Install ffmpeg from Debian's apt repo (this is the real binary, not wasm)
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./

# Render sets $PORT at runtime — server.js reads it, this is just documentation
EXPOSE 3000

# Uploaded/converted files live here temporarily and get deleted after each
# job — see server.js cleanup logic. Render's disk is ephemeral anyway
# (wiped on every redeploy/restart), so nothing here is meant to persist.
RUN mkdir -p /app/tmp

CMD ["node", "server.js"]
