# Deploying Pix Post Builder

## Architecture

Two Railway services:

| Service | Root Directory | What it is |
|---|---|---|
| **app** | `.` | `server.mjs` — frontend, every `/api/*` route, **and the video pipeline** |
| **upscaler** | `upscaler` | AI Enhance (CodeFormer + Real-ESRGAN) |

`server.mjs` serves the static frontend and all API routes, and shells out to
`ffmpeg` and `yt-dlp` for Slide 2 video. The upscaler stays separate because
PyTorch plus model weights is a genuinely different runtime, not a binary you
shell out to.

The app builds from the root `Dockerfile` (node:20-slim + ffmpeg + the yt-dlp
binary). **It cannot use Nixpacks** — that gives you Node without ffmpeg and
every video export fails.

> **Why video isn't a separate service.** It was, briefly. Vercel caps
> serverless request bodies at 4.5 MB, so a 20–200 MB upload could never
> transit a function; the browser had to POST to a second host, which needed
> a shared secret, HMAC tokens and CORS. Railway has no such cap, so
> `/api/video/*` are now ordinary same-origin routes and all of that is gone.

## Environment variables

Set on the **app** service:

| Name | Required? | Purpose |
|---|---|---|
| `OPENAI_API_KEY` | **yes** | article writer, tweet captions, vision |
| `SHORTLY_AGENT_AUTH_SECRET` | **yes** | Shortly Agents access gate. Unset = no gate, app open to anyone |
| `YTDLP_COOKIES` | for video | base64 `cookies.txt`. Without it YouTube bot-checks this server and Instagram mostly fails |
| `UPSCALER_URL` | for AI Enhance | upscaler domain, no trailing slash. Unset = falls back to paid gpt-image |
| `UPSCALER_SECRET` | for AI Enhance | must match the upscaler service |
| `PEXELS_API_KEY` | optional | stock images. Unset = that source is skipped |
| `FAL_KEY` | optional | Flux image generation (last-resort, paid) |
| `IMAGE_QUALITY` | optional | `medium` (default). low ≈ $0.016, medium ≈ $0.06, high ≈ $0.25 per image |
| `MAX_CLIP_SECONDS` | optional | `90` |
| `MAX_UPLOAD_BYTES` | optional | `314572800` (300 MB) |
| `TWITTER_API_KEY` etc. | optional | only for `/api/twitter/post` |

Set on the **upscaler** service: `UPSCALER_SECRET` (plus its own options —
see [upscaler/README.md](upscaler/README.md)).

**Do not set `PORT`.** Railway injects it; hard-coding it makes the container
unreachable behind their proxy.

## Cookies for YouTube / Instagram

YouTube serves *"Sign in to confirm you're not a bot"* to datacenter IPs,
which is what Railway is. Instagram needs a session for nearly everything.

1. Install a "Get cookies.txt LOCALLY" browser extension.
2. Log in to YouTube (and Instagram), export `cookies.txt`.
3. Base64 it — Railway's variable field is single-line:

   ```bash
   base64 -w0 cookies.txt
   ```

4. Paste as `YTDLP_COOKIES`.

Use a **throwaway account**: these are full session credentials, and
automated access can get an account rate-limited or banned. They expire after
weeks to months — re-export when downloads start failing with a login error.

## Deploy

1. **railway.app → New Project → Deploy from GitHub repo** → `DridhaTeamHQ/pixAgent`
2. **Settings → Root Directory: `.`** — Railway reads `railway.json`
   (Dockerfile build, healthcheck `/health`).
3. Add the variables above.
4. **Settings → Networking → Generate Domain**
5. Repeat as a second service with Root Directory `upscaler`.

## Verify

```bash
curl https://YOUR-APP.up.railway.app/health
```

```json
{"ok":true,"uptime":42,
 "features":{"openai":true,"upscaler":true,"ffmpeg":true,
             "ytdlp":true,"ytdlpCookies":true,"pexels":true}}
```

- `ffmpeg` or `ytdlp` false → the image built wrong; check the build log.
- Anything else false → that variable is missing or misspelled.

Then exercise the three real paths: a scrape, an article generation, and a
video export.

## Keeping yt-dlp current

A stale yt-dlp is the most common cause of "download failed" — YouTube
changes its player regularly. The version is an `ARG` in the root
`Dockerfile`; bump `YTDLP_VERSION` and redeploy when extraction breaks.
Releases: https://github.com/yt-dlp/yt-dlp/releases

## Dead code to remove

`api/`, `netlify/functions/`, `netlify.toml` and `vercel.json` are **no
longer used** — Railway runs `server.mjs` for everything. They are ~2,200
lines still carrying duplicate copies of `EDITORIAL_SYSTEM_PROMPT`,
`clampBullet`, `repairBullets`, `clampTweet` and `buildEnhancePrompt`, so
every editorial change has to be applied twice until they are deleted.

## Local development

```bash
npm install
npm run dev          # node --watch server.mjs (port 3000)
```

Video needs `ffmpeg` and `yt-dlp` on your `PATH`. `/health` reports whether
both were found. `.env` is read **once at startup** — restart after editing
it.

## Repo layout

```
pixAgent/
├── Dockerfile              ← app image: node + ffmpeg + yt-dlp
├── railway.json            ← Railway build/deploy config
├── server.mjs              ← the whole backend
├── public/                 ← static frontend
│   ├── index.html
│   ├── app.js
│   ├── styles.css
│   └── assests/
├── lib/                    ← shared helpers
├── upscaler/               ← separate Railway service (AI Enhance)
├── api/                    ← DEAD: old Vercel serverless functions
├── netlify/                ← DEAD: stale Netlify mirror
└── vercel.json             ← DEAD
```
