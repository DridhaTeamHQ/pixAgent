"""
Pix Media Service — yt-dlp fetch + ffmpeg trim/composite.

Why this is a separate Railway service instead of a Vercel function:
  * yt-dlp + ffmpeg are ~150 MB of binaries; Vercel's bundle cap is 250 MB
    and cold-starting that per request is hopeless.
  * Vercel serverless caps request bodies at 4.5 MB. A local video upload
    blows through that instantly, so the browser talks to THIS service
    directly (see the token auth below).
  * Transcoding takes minutes, not the 10s a serverless function wants.

Branding is NOT re-implemented here. The browser renders the exact same
overlay it shows in the preview (logo, dim gradient, headline/bullet text)
to a transparent PNG and POSTs it alongside the clip request; ffmpeg just
composites it. That keeps fonts, layout and highlight colours pixel-identical
to what the user approved on screen, and means editorial layout changes never
need a redeploy of this service.

Endpoints:
  GET  /health   -> {"ok": true, ...}
  POST /resolve  -> {"url": "..."} -> video metadata, no download
  POST /clip     -> multipart: trim + burn overlay -> MP4 bytes

Auth:
  Every request carries either
    X-Secret: <MEDIA_SECRET>            (server-to-server)
  or
    X-Media-Token: <ts.sig>             (browser, minted by /api/media-token)
  The token is HMAC-SHA256(str(expiry), MEDIA_SECRET) so the shared secret
  itself never reaches the browser.

Env:
  MEDIA_SECRET      shared secret (required in production)
  ALLOWED_ORIGINS   comma-separated CORS origins for direct browser calls
  YTDLP_COOKIES     base64-encoded Netscape cookies.txt — needed for YouTube
                    bot-checks from datacenter IPs and for most of Instagram
  MAX_CLIP_SECONDS  hard cap on output length (default 90)
  MAX_UPLOAD_BYTES  hard cap on a local upload (default 300 MB)
"""

import os
import base64
import binascii
import hmac
import hashlib
import json
import shutil
import subprocess
import time
import uuid

from fastapi import FastAPI, Request, Header, HTTPException, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, JSONResponse

app = FastAPI(title="Pix Media Service")

SECRET = os.environ.get("MEDIA_SECRET", "")
MAX_CLIP_SECONDS = float(os.environ.get("MAX_CLIP_SECONDS", "90"))
MAX_UPLOAD_BYTES = int(os.environ.get("MAX_UPLOAD_BYTES", str(300 * 1024 * 1024)))
RESOLVE_TIMEOUT = int(os.environ.get("RESOLVE_TIMEOUT", "60"))
CLIP_TIMEOUT = int(os.environ.get("CLIP_TIMEOUT", "600"))

_origins = [o.strip() for o in os.environ.get("ALLOWED_ORIGINS", "*").split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_origins or ["*"],
    allow_methods=["POST", "GET", "OPTIONS"],
    allow_headers=["*"],
    expose_headers=["X-Clip-Duration", "X-Source-Title"],
)

# ── Cookies ───────────────────────────────────────────────────────────────
# YouTube serves "Sign in to confirm you're not a bot" to datacenter IPs
# (which is exactly what Railway is), and Instagram needs a session for all
# but a thin slice of public content. A cookies.txt exported from a logged-in
# browser fixes both. Stored base64 in the env so it survives Railway's
# single-line variable UI.
COOKIE_FILE = "/tmp/cookies.txt"


def _write_cookie_file() -> str:
    raw = os.environ.get("YTDLP_COOKIES", "").strip()
    if not raw:
        return ""
    try:
        data = base64.b64decode(raw, validate=True)
    except (binascii.Error, ValueError):
        # Allow pasting the file verbatim too, not just base64.
        data = raw.encode("utf-8")
    try:
        with open(COOKIE_FILE, "wb") as f:
            f.write(data)
        return COOKIE_FILE
    except OSError:
        return ""


COOKIES = _write_cookie_file()


def _ytdlp_base() -> list:
    cmd = ["yt-dlp", "--no-playlist", "--no-warnings"]
    if COOKIES:
        cmd += ["--cookies", COOKIES]
    return cmd


# ── Auth ──────────────────────────────────────────────────────────────────
def _token_is_valid(token: str) -> bool:
    """Verify `<expiry>.<hex sig>` minted by the Pix backend."""
    if not token or "." not in token:
        return False
    ts, _, sig = token.partition(".")
    try:
        expiry = int(ts)
    except ValueError:
        return False
    if expiry < time.time():
        return False
    expected = hmac.new(SECRET.encode(), ts.encode(), hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, sig)


def _authorize(x_secret: str, x_media_token: str) -> None:
    if not SECRET:
        return  # unset = open, for local development only
    if x_secret and hmac.compare_digest(x_secret, SECRET):
        return
    if _token_is_valid(x_media_token):
        return
    raise HTTPException(status_code=401, detail="unauthorized")


@app.get("/health")
def health():
    return {
        "ok": True,
        "cookies": bool(COOKIES),
        "ffmpeg": shutil.which("ffmpeg") is not None,
        "ytdlp": shutil.which("yt-dlp") is not None,
    }


# ── Resolve ───────────────────────────────────────────────────────────────
@app.post("/resolve")
async def resolve(
    request: Request,
    x_secret: str = Header(default=""),
    x_media_token: str = Header(default=""),
):
    """Metadata only — no media bytes are downloaded."""
    _authorize(x_secret, x_media_token)

    body = await request.json()
    url = (body or {}).get("url", "").strip()
    if not url.startswith(("http://", "https://")):
        raise HTTPException(status_code=400, detail="a http(s) url is required")

    cmd = _ytdlp_base() + ["--dump-single-json", "--skip-download", url]
    try:
        proc = subprocess.run(cmd, capture_output=True, timeout=RESOLVE_TIMEOUT)
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=504, detail="resolve timed out")

    if proc.returncode != 0:
        raise HTTPException(status_code=502, detail=_friendly_ytdlp_error(proc))

    try:
        info = json.loads(proc.stdout.decode("utf-8", "ignore"))
    except json.JSONDecodeError:
        raise HTTPException(status_code=502, detail="could not parse video metadata")

    return {
        "title": info.get("title") or "",
        "duration": info.get("duration") or 0,
        "thumbnail": info.get("thumbnail") or "",
        "uploader": info.get("uploader") or info.get("channel") or "",
        "extractor": info.get("extractor_key") or "",
        "width": info.get("width") or 0,
        "height": info.get("height") or 0,
        "webpage_url": info.get("webpage_url") or url,
    }


def _friendly_ytdlp_error(proc) -> str:
    """Turn yt-dlp's wall of stderr into something a user can act on."""
    err = (proc.stderr or proc.stdout or b"").decode("utf-8", "ignore")
    low = err.lower()
    if "sign in to confirm" in low or "not a bot" in low:
        return (
            "YouTube blocked this request as automated. Set YTDLP_COOKIES on the "
            "media service with cookies from a logged-in account."
        )
    if "login required" in low or "requested content is not available" in low:
        return (
            "This content requires a login. Set YTDLP_COOKIES on the media service "
            "with cookies from an account that can view it."
        )
    if "private video" in low:
        return "That video is private."
    if "video unavailable" in low or "removed" in low:
        return "That video is unavailable or has been removed."
    if "unsupported url" in low:
        return "That link isn't a supported video URL."
    if "rate-limit" in low or "429" in low:
        return "The source is rate-limiting this server. Try again in a few minutes."
    tail = err.strip().splitlines()[-1] if err.strip() else "download failed"
    return tail[:300]


# ── Clip ──────────────────────────────────────────────────────────────────
@app.post("/clip")
async def clip(
    url: str = Form(default=""),
    start: float = Form(default=0.0),
    end: float = Form(default=0.0),
    width: int = Form(default=1080),
    height: int = Form(default=1920),
    mute: bool = Form(default=False),
    overlay: UploadFile = File(default=None),
    video: UploadFile = File(default=None),
    x_secret: str = Header(default=""),
    x_media_token: str = Header(default=""),
):
    """
    Trim a clip and burn the supplied overlay PNG over it.

    Source is either `url` (scraped via yt-dlp) or `video` (a local upload).
    `overlay` is a transparent PNG at exactly width×height, rendered by the
    browser so the branding matches the on-screen preview exactly.
    """
    _authorize(x_secret, x_media_token)

    duration = round(end - start, 3)
    if duration <= 0:
        raise HTTPException(status_code=400, detail="end must be after start")
    if duration > MAX_CLIP_SECONDS:
        raise HTTPException(
            status_code=400,
            detail=f"clip is {duration:.0f}s; the limit is {MAX_CLIP_SECONDS:.0f}s",
        )
    if width <= 0 or height <= 0 or width % 2 or height % 2:
        raise HTTPException(status_code=400, detail="width/height must be positive even numbers")
    if not url and video is None:
        raise HTTPException(status_code=400, detail="supply either a url or a video file")

    job = uuid.uuid4().hex
    root = f"/tmp/{job}"
    os.makedirs(root, exist_ok=True)
    src = f"{root}/source.mp4"
    out = f"{root}/out.mp4"

    try:
        if video is not None:
            written = 0
            with open(src, "wb") as f:
                while chunk := await video.read(1024 * 1024):
                    written += len(chunk)
                    if written > MAX_UPLOAD_BYTES:
                        raise HTTPException(status_code=413, detail="video file too large")
                    f.write(chunk)
            if written < 1000:
                raise HTTPException(status_code=400, detail="empty or invalid video file")
        else:
            _download(url, src)

        overlay_path = ""
        if overlay is not None:
            overlay_path = f"{root}/overlay.png"
            data = await overlay.read()
            if data:
                with open(overlay_path, "wb") as f:
                    f.write(data)
            else:
                overlay_path = ""

        _transcode(src, out, overlay_path, start, duration, width, height, mute)

        with open(out, "rb") as f:
            payload = f.read()
        if len(payload) < 1000:
            raise HTTPException(status_code=500, detail="encoder produced an empty file")

        return Response(
            content=payload,
            media_type="video/mp4",
            headers={
                "X-Clip-Duration": str(duration),
                "Content-Disposition": 'attachment; filename="clip.mp4"',
            },
        )
    finally:
        shutil.rmtree(root, ignore_errors=True)


def _download(url: str, dest: str) -> None:
    """Fetch the best mp4-compatible stream yt-dlp can give us."""
    if not url.startswith(("http://", "https://")):
        raise HTTPException(status_code=400, detail="a http(s) url is required")
    cmd = _ytdlp_base() + [
        "-f", "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b",
        "--merge-output-format", "mp4",
        "-o", dest,
        url,
    ]
    try:
        proc = subprocess.run(cmd, capture_output=True, timeout=CLIP_TIMEOUT)
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=504, detail="download timed out")
    if proc.returncode != 0 or not os.path.exists(dest):
        raise HTTPException(status_code=502, detail=_friendly_ytdlp_error(proc))


def _transcode(src, out, overlay_path, start, duration, width, height, mute):
    """
    Scale-to-cover + centre-crop the source to width×height, then composite
    the overlay PNG on top. `-ss` sits before `-i` for a fast keyframe seek;
    ffmpeg still decodes accurately from there because we re-encode anyway.
    """
    cover = (
        f"scale={width}:{height}:force_original_aspect_ratio=increase,"
        f"crop={width}:{height},setsar=1"
    )
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-ss", str(start), "-i", src]

    if overlay_path:
        cmd += ["-i", overlay_path]
        filt = f"[0:v]{cover}[bg];[1:v]scale={width}:{height}[ov];[bg][ov]overlay=0:0[v]"
    else:
        filt = f"[0:v]{cover}[v]"

    cmd += ["-t", str(duration), "-filter_complex", filt, "-map", "[v]"]

    if mute:
        cmd += ["-an"]
    else:
        # `?` makes the audio stream optional — sources without audio (many
        # Reels, silent b-roll) would otherwise fail the whole encode.
        cmd += ["-map", "0:a?", "-c:a", "aac", "-b:a", "128k"]

    cmd += [
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-crf", "20",
        "-pix_fmt", "yuv420p",     # required for playback on Safari / iOS
        "-movflags", "+faststart", # metadata up front so it streams
        out,
    ]

    try:
        proc = subprocess.run(cmd, capture_output=True, timeout=CLIP_TIMEOUT)
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=504, detail="encode timed out")
    if proc.returncode != 0:
        tail = (proc.stderr or proc.stdout or b"").decode("utf-8", "ignore")[-400:]
        raise HTTPException(status_code=500, detail=f"ffmpeg failed: {tail}")


@app.exception_handler(Exception)
async def unhandled(_request, exc):
    if isinstance(exc, HTTPException):
        return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})
    return JSONResponse(status_code=500, content={"detail": str(exc)[:300]})
