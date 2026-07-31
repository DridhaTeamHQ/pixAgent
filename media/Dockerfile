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

# YouTube changes its player regularly and an outdated yt-dlp is the single
# most common cause of "download failed", so this pin needs bumping more often
# than anything else here. 2026.07.04 is the build verified end to end against
# a real YouTube fetch; check https://github.com/yt-dlp/yt-dlp/releases when
# extraction starts failing.
RUN pip install \
      "yt-dlp==2026.07.04" \
      fastapi \
      "uvicorn[standard]" \
      python-multipart

COPY app.py /app/app.py

# Railway injects PORT. The long keep-alive matches CLIP_TIMEOUT so a slow
# download+encode isn't cut off at the HTTP layer.
CMD ["sh", "-c", "uvicorn app:app --host 0.0.0.0 --port ${PORT:-8080} --timeout-keep-alive 620"]
