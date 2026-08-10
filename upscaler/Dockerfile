# ── Pix AI Upscaler — CodeFormer (face restore) + Real-ESRGAN (background) ──
# Self-hosted on Railway. CPU-only; no GPU required.
# torch/torchvision are pinned to the combo CodeFormer's vendored basicsr
# imports cleanly against (0.15.x still ships torchvision.transforms.functional_tensor).

FROM python:3.10-slim

ENV DEBIAN_FRONTEND=noninteractive \
    PIP_NO_CACHE_DIR=1 \
    PYTHONUNBUFFERED=1

# System libs: OpenCV runtime + downloaders
RUN apt-get update && apt-get install -y --no-install-recommends \
      git wget ca-certificates \
      libgl1 libglib2.0-0 libsm6 libxext6 libxrender1 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# CPU PyTorch (pinned — see note above)
RUN pip install torch==2.0.1 torchvision==0.15.2 --index-url https://download.pytorch.org/whl/cpu

# CodeFormer (bundles its own basicsr + the full inference pipeline)
RUN git clone --depth 1 https://github.com/sczhou/CodeFormer.git /app/CodeFormer
WORKDIR /app/CodeFormer
RUN pip install -r requirements.txt \
 && python basicsr/setup.py develop \
 && pip install fastapi "uvicorn[standard]" python-multipart pillow \
      spandrel

# Pre-download model weights so the first request is fast and offline-safe:
# face detection + parsing (facelib), the CodeFormer net, and the
# Real-ESRGAN x2 background upsampler.
RUN python scripts/download_pretrained_models.py facelib \
 && python scripts/download_pretrained_models.py CodeFormer \
 && mkdir -p /app/CodeFormer/weights/realesrgan \
 && wget -q https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.1/RealESRGAN_x2plus.pth \
      -O /app/CodeFormer/weights/realesrgan/RealESRGAN_x2plus.pth

# SwinIR weights, used when ENGINE=swinir. ~140 MB — the bulk of this
# image. Drop this layer if only Real-ESRGAN will ever be used.
RUN mkdir -p /app/weights/swinir \
 && wget -q https://github.com/JingyunLiang/SwinIR/releases/download/v0.0/003_realSR_BSRGAN_DFOWMFC_s64w8_SwinIR-L_x4_GAN.pth \
      -O /app/weights/swinir/swinir_real_sr_x4_large.pth

WORKDIR /app
COPY app.py /app/app.py
COPY realesrgan_runner.py /app/realesrgan_runner.py
COPY swinir_runner.py /app/swinir_runner.py

# Railway injects PORT.
CMD ["sh", "-c", "uvicorn app:app --host 0.0.0.0 --port ${PORT:-8000} --timeout-keep-alive 300"]
