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
import io

from PIL import Image

from fastapi import FastAPI, Request, Header, HTTPException
from fastapi.responses import Response, JSONResponse

app = FastAPI(title="Pix AI Upscaler")

CODEFORMER_DIR = os.environ.get("CODEFORMER_DIR", "/app/CodeFormer")
PYTHON_BIN = os.environ.get("PYTHON_BIN", "python")
SECRET   = os.environ.get("UPSCALER_SECRET", "")
FIDELITY = os.environ.get("CODEFORMER_FIDELITY", "1.0")
UPSCALE  = os.environ.get("UPSCALE", "2")
TIMEOUT  = int(os.environ.get("ENHANCE_TIMEOUT", "280"))
MAX_BYTES = 12 * 1024 * 1024
# How much of the model's output to keep, 0..1. 1.0 is the raw model; lower
# values mix back toward a plain resample and remove the painted look at the
# cost of some crispness. Overridable per request via X-Enhance-Strength.
ENHANCE_STRENGTH = float(os.environ.get("ENHANCE_STRENGTH", "0.7"))

# ENGINE:
#   realesrgan (default) — pure pixel super-resolution of the whole frame.
#                          Faces stay derived from the original pixels; safe
#                          for news photography.
#   swinir               — transformer restoration via spandrel. Sharper than
#                          Real-ESRGAN and without its waxy, painted skin,
#                          which is the artefact that shows worst on faces.
#                          Roughly 7x the CPU time. Like realesrgan it only
#                          resamples — no face model, so identity is safe.
#   codeformer           — adds the CodeFormer face restorer. Reconstructs
#                          faces through a learned codebook: dramatic on
#                          ruined low-res faces, but drifts identity (e.g.
#                          shaves stubble) on decent ones. Opt-in only.
ENGINE = os.environ.get("ENGINE", "realesrgan").lower()

# realesrgan_runner.py ships next to this file; it must run from inside the
# CodeFormer repo so its vendored basicsr imports resolve.
RUNNER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "realesrgan_runner.py")
SWINIR_RUNNER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "swinir_runner.py")



def blend_toward_resample(model_png_path, source_path, strength):
    """Mix the model's output back toward a plain Lanczos resample.

    Why this exists: measured against an undegraded original, both
    Real-ESRGAN and SwinIR produce roughly TWICE the fine detail the
    original has (372 and 347 against 189). They are not recovering face
    detail, they are manufacturing it — hardened edges with smoothed skin
    between them, which is exactly the "painted" look on portraits. On the
    same test a plain resample scored closest to the original of anything.

    So the useful control is not a different model, it is how much of the
    model to keep. strength=1.0 is the raw model, 0.0 is a pure resample,
    and values between trade artefact for softness continuously.

    Costs nothing: one resize and one blend, no extra inference.
    """
    if strength >= 0.999:
        with open(model_png_path, "rb") as f:
            return f.read()

    enhanced = Image.open(model_png_path).convert("RGB")
    # The plain baseline is the ORIGINAL upscaled to the model's output size,
    # so the two are pixel-aligned and only differ by what the model added.
    base = Image.open(source_path).convert("RGB").resize(enhanced.size, Image.LANCZOS)

    mixed = Image.blend(base, enhanced, max(0.0, min(1.0, strength)))
    buf = io.BytesIO()
    mixed.save(buf, format="PNG")
    return buf.getvalue()


@app.get("/health")
def health():
    return {"ok": True, "engine": ENGINE, "strength": ENHANCE_STRENGTH}


@app.post("/enhance")
async def enhance(
    request: Request,
    x_secret: str = Header(default=""),
    x_enhance_strength: str = Header(default=""),
):
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
        if ENGINE == "codeformer":
            cmd = [
                PYTHON_BIN, "inference_codeformer.py",
                "-w", str(FIDELITY),
                "--upscale", str(UPSCALE),
                "--bg_upsampler", "realesrgan",
                "--face_upsample",
                "--input_path", indir,
                "--output_path", outdir,
            ]
        elif ENGINE == "swinir":
            cmd = [PYTHON_BIN, SWINIR_RUNNER, f"{indir}/img.png", f"{outdir}/img.png"]
        else:
            cmd = [PYTHON_BIN, RUNNER, f"{indir}/img.png", f"{outdir}/img.png"]

        # CodeFormer and the Real-ESRGAN runner import CodeFormer's vendored
        # basicsr, so they must run from inside that repo. SwinIR goes through
        # spandrel and has no such dependency — forcing it into that directory
        # only breaks the run wherever the repo is not checked out.
        cwd = None if ENGINE == "swinir" else CODEFORMER_DIR
        proc = subprocess.run(
            cmd, cwd=cwd, capture_output=True, timeout=TIMEOUT,
        )
        if proc.returncode != 0:
            tail = (proc.stderr or proc.stdout or b"").decode("utf-8", "ignore")[-400:]
            raise HTTPException(status_code=500, detail=f"{ENGINE} failed: {tail}")

        # CodeFormer writes full frames under final_results/; the realesrgan
        # runner writes outdir/img.png. Either way, skip per-face crops.
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

        try:
            strength = float(x_enhance_strength) if x_enhance_strength else ENHANCE_STRENGTH
        except ValueError:
            strength = ENHANCE_STRENGTH
        strength = max(0.0, min(1.0, strength))

        out = blend_toward_resample(best, f"{indir}/img.png", strength)
        return Response(
            content=out,
            media_type="image/png",
            headers={"X-Engine": ENGINE, "X-Enhance-Strength": f"{strength:.2f}"},
        )

    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=504, detail="enhance timed out")
    finally:
        shutil.rmtree(root, ignore_errors=True)


@app.exception_handler(Exception)
async def unhandled(_request, exc):
    return JSONResponse(status_code=500, content={"detail": str(exc)[:300]})
