# ── Pix Media Service — yt-dlp (fetch) + ffmpeg (trim / composite) ──
# Self-hosted on Railway. CPU-only, no GPU, no model weights — this image is
# small and builds in well under a minute, unlike the upscaler.

FROM python:3.11-slim

ENV DEBIAN_FRONTEND=noninteractive \
    PIP_NO_CACHE_DIR=1 \
    PYTHONUNBUFFERED=1

# ffmpeg does all the trimming and compositing. ca-certificates is required
# for yt-dlp's TLS connections to YouTube/Instagram.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# yt-dlp is pinned to a recent release but is deliberately easy to bump —
# YouTube changes its player regularly and an outdated yt-dlp is the single
# most common cause of "download failed". Bump this pin if extraction breaks.
RUN pip install \
      "yt-dlp==2026.1.26" \
      fastapi \
      "uvicorn[standard]" \
      python-multipart

COPY app.py /app/app.py

# Railway injects PORT. The long keep-alive matches CLIP_TIMEOUT so a slow
# download+encode isn't cut off at the HTTP layer.
CMD ["sh", "-c", "uvicorn app:app --host 0.0.0.0 --port ${PORT:-8080} --timeout-keep-alive 620"]
