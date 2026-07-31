# Pix Media Service

Fetches video from YouTube/Instagram (yt-dlp), trims it to a chosen range, and
burns the Pix/Shortly branding over it (ffmpeg). Runs on Railway alongside the
upscaler.

## Why it isn't a Vercel function

Three hard blockers, any one of which is fatal:

| Constraint | Reality |
|---|---|
| Bundle size | yt-dlp + ffmpeg are ~150 MB; Vercel's cap is 250 MB unzipped |
| Request body | Vercel serverless caps bodies at **4.5 MB** — a local video upload is routinely 20–200 MB |
| Duration | A download + transcode runs for minutes |

So the **browser talks to this service directly**. `/api/media-token` on the Pix
backend mints a short-lived HMAC token; `MEDIA_SECRET` itself never reaches the
client.

## Branding is rendered by the browser, not here

This service has no fonts, no layout tables and no knowledge of the Pix design.
The browser renders the exact overlay it shows in the live preview to a
transparent PNG and POSTs it with the clip request; ffmpeg just composites it.

That means the branding in the exported file is guaranteed to be what the user
approved on screen, and **editorial or layout changes never require redeploying
this service**.

## Deploy on Railway

1. **New Project → Deploy from GitHub repo** → `DridhaTeamHQ/pixAgent`
2. **Settings → Root Directory:** `media`
3. **Variables:**

   | Name | Value |
   |---|---|
   | `MEDIA_SECRET` | a long random string (generate with `openssl rand -hex 32`) |
   | `ALLOWED_ORIGINS` | `https://your-pix-domain.vercel.app` — comma-separated; required for direct browser calls |
   | `YTDLP_COOKIES` | base64 of a `cookies.txt` — see below |

4. **Settings → Networking → Generate Domain**
5. Back in the **Pix** project (Vercel) set:

   | Name | Value |
   |---|---|
   | `MEDIA_URL` | the Railway domain, e.g. `https://pix-media.up.railway.app` |
   | `MEDIA_SECRET` | the same secret as above |

Verify with `curl https://<domain>/health` — expect
`{"ok":true,"cookies":true,"ffmpeg":true,"ytdlp":true}`. If `cookies` is
`false`, `YTDLP_COOKIES` didn't parse.

## Cookies — why you need them

YouTube serves *"Sign in to confirm you're not a bot"* to datacenter IPs, which
is exactly what Railway is. Instagram needs a session for all but a thin slice
of public content. A `cookies.txt` exported from a logged-in browser fixes both.

1. Install a "Get cookies.txt LOCALLY" browser extension.
2. Log in to YouTube (and/or Instagram), export `cookies.txt`.
3. Base64 it — Railway's variable UI is single-line, so raw multi-line files
   don't paste cleanly:

   ```bash
   base64 -w0 cookies.txt
   ```

4. Paste the result as `YTDLP_COOKIES`.

Cookies expire — typically weeks to months. When downloads start failing with a
login error, re-export. **Use a throwaway account:** automated access can get
an account rate-limited or banned, and these cookies are full session
credentials.

## API

All endpoints require `X-Secret: <MEDIA_SECRET>` (server-to-server) **or**
`X-Media-Token: <ts>.<sig>` (browser). With `MEDIA_SECRET` unset the service
runs open — local development only.

### `GET /health`
```json
{"ok": true, "cookies": true, "ffmpeg": true, "ytdlp": true}
```

### `POST /resolve`
Metadata only; downloads nothing.
```json
{"url": "https://youtube.com/watch?v=..."}
```
→ `{title, duration, thumbnail, uploader, extractor, width, height, webpage_url}`

### `POST /clip`
`multipart/form-data` → MP4 bytes.

| Field | Notes |
|---|---|
| `url` | source link — **or** `video`, one is required |
| `video` | uploaded file, up to `MAX_UPLOAD_BYTES` (300 MB) |
| `overlay` | transparent PNG at exactly `width`×`height` |
| `start`, `end` | seconds; `end - start` ≤ `MAX_CLIP_SECONDS` (90) |
| `width`, `height` | output size, must be **even** (libx264 + yuv420p) |
| `mute` | `true` drops the audio track |

Output is H.264 / AAC, `+faststart`, `yuv420p` (required for Safari and iOS).

## Environment

| Var | Default | Purpose |
|---|---|---|
| `MEDIA_SECRET` | — | shared secret; unset = open |
| `ALLOWED_ORIGINS` | `*` | CORS origins for direct browser calls |
| `YTDLP_COOKIES` | — | base64 `cookies.txt` |
| `MAX_CLIP_SECONDS` | `90` | hard cap on output length |
| `MAX_UPLOAD_BYTES` | `314572800` | 300 MB upload cap |
| `RESOLVE_TIMEOUT` | `60` | seconds |
| `CLIP_TIMEOUT` | `600` | seconds, covers download + encode |

## Run locally

ffmpeg and yt-dlp must be on `PATH`.

```bash
pip install fastapi "uvicorn[standard]" python-multipart yt-dlp
MEDIA_SECRET=devsecret python -m uvicorn app:app --port 8770
```

Then point the Pix `.env` at it:

```
MEDIA_URL=http://127.0.0.1:8770
MEDIA_SECRET=devsecret
```

## Keeping yt-dlp current

An outdated yt-dlp is the single most common cause of "download failed" —
YouTube changes its player regularly. The version is pinned in the
`Dockerfile`; bump it and redeploy when extraction breaks.

## Legal

Downloading from YouTube and Instagram is against their Terms of Service.
News clipping under fair use / fair dealing is routine industry practice, but
the exposure is yours. The bot-checks the cookies work around exist precisely
because these platforms don't want automated downloads.
