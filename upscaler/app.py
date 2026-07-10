"""
Pix AI Upscaler — FastAPI wrapper around CodeFormer's tested inference script.

Why subprocess the official script instead of re-implementing the pipeline:
CodeFormer's inference_codeformer.py already does face detection, alignment,
CodeFormer restoration, Real-ESRGAN background upsampling and paste-back,
with correct CPU handling. Wrapping it is far more reliable than reproducing
that wiring by hand.

Endpoints:
  GET  /health   -> {"ok": true}
  POST /enhance  -> raw image bytes in, restored PNG bytes out
                    header  X-Secret: <UPSCALER_SECRET>   (if configured)
Env:
  UPSCALER_SECRET       shared secret the Pix backend must send (optional but recommended)
  CODEFORMER_FIDELITY   0..1, 0.7 default (higher = more faithful to the original)
  UPSCALE               integer upscale factor, 2 default
"""

import os
import glob
import uuid
import shutil
import subprocess

from fastapi import FastAPI, Request, Header, HTTPException
from fastapi.responses import Response, JSONResponse

app = FastAPI(title="Pix AI Upscaler")

CODEFORMER_DIR = "/app/CodeFormer"
SECRET   = os.environ.get("UPSCALER_SECRET", "")
FIDELITY = os.environ.get("CODEFORMER_FIDELITY", "0.7")
UPSCALE  = os.environ.get("UPSCALE", "2")
TIMEOUT  = int(os.environ.get("ENHANCE_TIMEOUT", "280"))
MAX_BYTES = 12 * 1024 * 1024


@app.get("/health")
def health():
    return {"ok": True, "engine": "codeformer+realesrgan"}


@app.post("/enhance")
async def enhance(request: Request, x_secret: str = Header(default="")):
    if SECRET and x_secret != SECRET:
        raise HTTPException(status_code=401, detail="unauthorized")

    data = await request.body()
    if not data or len(data) < 1000:
        raise HTTPException(status_code=400, detail="empty or invalid image body")
    if len(data) > MAX_BYTES:
        raise HTTPException(status_code=413, detail="image too large")

    job = uuid.uuid4().hex
    root = f"/tmp/{job}"
    indir, outdir = f"{root}/in", f"{root}/out"
    os.makedirs(indir, exist_ok=True)
    os.makedirs(outdir, exist_ok=True)
    with open(f"{indir}/img.png", "wb") as f:
        f.write(data)

    try:
        cmd = [
            "python", "inference_codeformer.py",
            "-w", str(FIDELITY),
            "--upscale", str(UPSCALE),
            "--bg_upsampler", "realesrgan",
            "--face_upsample",
            "--input_path", indir,
            "--output_path", outdir,
        ]
        proc = subprocess.run(
            cmd, cwd=CODEFORMER_DIR, capture_output=True, timeout=TIMEOUT,
        )
        if proc.returncode != 0:
            tail = (proc.stderr or proc.stdout or b"").decode("utf-8", "ignore")[-400:]
            raise HTTPException(status_code=500, detail=f"codeformer failed: {tail}")

        # Final full-frame results live in final_results/. Ignore the per-face
        # crops (cropped_faces / restored_faces).
        imgs = [
            p for p in glob.glob(f"{outdir}/**/*", recursive=True)
            if p.lower().endswith((".png", ".jpg", ".jpeg"))
            and "cropped_faces" not in p and "restored_faces" not in p
        ]
        final = [p for p in imgs if "final_results" in p] or imgs
        if not final:
            raise HTTPException(status_code=500, detail="no output produced")
        # If several, take the largest file (the full restored image).
        best = max(final, key=lambda p: os.path.getsize(p))
        with open(best, "rb") as f:
            out = f.read()
        return Response(content=out, media_type="image/png")

    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=504, detail="enhance timed out")
    finally:
        shutil.rmtree(root, ignore_errors=True)


@app.exception_handler(Exception)
async def unhandled(_request, exc):
    return JSONResponse(status_code=500, content={"detail": str(exc)[:300]})
