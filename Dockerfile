# ── Pix Post Builder — app + video pipeline in one container ──
#
# Node serves the frontend and every /api/* route, and shells out to ffmpeg
# and yt-dlp for the Slide 2 video feature. These used to be a separate
# Python/FastAPI service because Vercel caps serverless request bodies at
# 4.5 MB, so a video upload could not pass through the backend at all. On
# Railway that limit doesn't exist, so the split bought nothing but a second
# container, a shared secret, HMAC tokens and CORS config.
#
# yt-dlp ships a self-contained PyInstaller binary for Linux, so no Python
# runtime is needed here.

FROM node:20-slim

ENV NODE_ENV=production \
    DEBIAN_FRONTEND=noninteractive

# ffmpeg does the trimming and overlay compositing.
# ca-certificates + wget are needed to fetch yt-dlp and for its TLS calls.
# unzip is for the deno archive below.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg ca-certificates wget unzip \
 && rm -rf /var/lib/apt/lists/*

# ── JavaScript runtime for yt-dlp ──
# YouTube requires solving a JS challenge to decipher stream URLs. yt-dlp
# calls extraction without a JS runtime "deprecated", and without one only
# the android_vr and tv_embedded clients work at all — every web-based
# client fails with "Requested format is not available". Deno is the runtime
# yt-dlp enables by default, so installing it unlocks the full client set
# and the best available formats.
RUN wget -q https://github.com/denoland/deno/releases/latest/download/deno-x86_64-unknown-linux-gnu.zip -O /tmp/deno.zip \
 && unzip -q /tmp/deno.zip -d /usr/local/bin \
 && rm /tmp/deno.zip \
 && chmod +x /usr/local/bin/deno \
 && /usr/local/bin/deno --version

# YouTube changes its player regularly and a stale yt-dlp is the single most
# common cause of "download failed" — this pin needs bumping more often than
# anything else in the image. 2026.07.04 is the build verified end to end
# against a real YouTube fetch.
ARG YTDLP_VERSION=2026.07.04
RUN wget -q "https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/yt-dlp_linux" \
      -O /usr/local/bin/yt-dlp \
 && chmod +x /usr/local/bin/yt-dlp \
 && /usr/local/bin/yt-dlp --version

WORKDIR /app

# Dependencies first so a source-only change doesn't reinstall node_modules.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.mjs ./
COPY lib ./lib
COPY public ./public

# Railway injects PORT; server.mjs reads it.
CMD ["node", "server.mjs"]
