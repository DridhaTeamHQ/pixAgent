# Deploying Pix Post Builder

## Current architecture

The website runs on **Vercel**. Two things that can't run in a serverless
function live on **Railway** as separate services:

| Piece | Host | Why |
|---|---|---|
| Website + all `/api/*` routes | Vercel | static + serverless functions |
| `upscaler/` — AI Enhance | Railway | PyTorch + model weights, minutes-long jobs |
| `media/` — Slide 2 video | Railway | yt-dlp + ffmpeg (~150 MB), 4.5 MB body cap, long encodes |

The browser calls the media service **directly** rather than through Vercel:
serverless request bodies are capped at 4.5 MB and a video upload is routinely
20–200 MB. `/api/media-token` signs a short-lived HMAC so `MEDIA_SECRET`
never reaches the client.

Skip to [Railway — media service](#railway--the-media-service-video) for the
video setup, or [Railway — whole app](#deploying-the-whole-app-to-railway-alternative)
for the all-in-one alternative.

## Repo layout

```
pixAgent/
├── public/                 ← static frontend (served at /)
│   ├── index.html
│   ├── app.js
│   ├── styles.css
│   └── assests/
├── api/                    ← serverless functions (each = one route)
│   ├── scrape-article.js   → POST /api/scrape-article
│   ├── stock-images.js     → GET  /api/stock-images?query=...
│   ├── google-images.js    → GET  /api/google-images?query=...
│   ├── image.js            → GET  /api/image?url=...      (CORS proxy)
│   └── generate-caption.js → POST /api/generate-caption
├── lib/                    ← shared helpers (auto-bundled into each fn)
│   ├── http.js
│   ├── scrape.js
│   └── image-search.js
├── server.mjs              ← local dev only (npm run dev)
├── vercel.json             ← rewrites public/ → /
└── package.json
```

## One-time setup on Vercel

1. **Connect the repo**
   - Go to https://vercel.com/new
   - Import `DridhaTeamHQ/pixAgent` from GitHub
   - Framework preset: **Other** (no build step needed)
   - Root directory: `.` (default)

2. **Add environment variables** (Project Settings → Environment Variables)

   | Name | Required for |
   |---|---|
   | `OPENAI_API_KEY` | AI tweet captions and product image OCR/pattern recognition |
   | `FAL_KEY` | Flux-generated background images |
   | `SHORTLY_AGENT_AUTH_SECRET` | Shortly Agents signed access tokens |
   | `PEXELS_API_KEY` | Stock background images |
   | `UPSCALER_URL` / `UPSCALER_SECRET` | Self-hosted AI Enhance (see `upscaler/README.md`) |
   | `MEDIA_URL` / `MEDIA_SECRET` | Slide 2 video — YouTube/Instagram scraping, trim, branded MP4 export (see `media/README.md`) |

   `MEDIA_URL` points at the Railway media service. Leave it empty and the
   video feature reports itself unconfigured instead of failing obscurely.
   `MEDIA_SECRET` must match the value set on that service — the browser
   uploads video straight to Railway (Vercel caps request bodies at 4.5 MB),
   authenticated by a short-lived token this backend signs with that secret.

   `SHORTLY_AGENT_AUTH_SECRET` must be the same secret used by Shortly Agents
   to sign Pix launch tokens. Pix accepts tokens shaped as
   `base64url(JSON payload).base64url(HMAC_SHA256(payload, secret))` with an
   optional `exp` Unix timestamp and `agentId` of `pix-post-agent` or `pix`.

   Twitter API keys are only needed if you re-enable `/api/twitter/post`. The
   current frontend only downloads PNG files and does not open X, so they can
   be omitted.

3. **Deploy** — every push to `main` auto-deploys.

## Railway — the media service (video)

This is the only Railway service the video feature needs. The website stays
on Vercel.

1. **railway.app → New Project → Deploy from GitHub repo** → `DridhaTeamHQ/pixAgent`
2. **Settings → Root Directory: `media`** ← the important one. Without it
   Railway tries to build the Node app instead.
   Railway then reads `media/railway.json`: Docker build, healthcheck `/health`.
3. **Variables:**

   | Name | Value |
   |---|---|
   | `MEDIA_SECRET` | `openssl rand -hex 32` |
   | `ALLOWED_ORIGINS` | your Vercel URLs, comma-separated (see note) |
   | `YTDLP_COOKIES` | `base64 -w0 cookies.txt` |

4. **Settings → Networking → Generate Domain**
5. Confirm: `curl https://<domain>/health` →
   `{"ok":true,"cookies":true,"ffmpeg":true,"ytdlp":true}`
   If `cookies` is `false`, `YTDLP_COOKIES` didn't decode.

Then in **Vercel → Settings → Environment Variables**, add `MEDIA_URL` (the
Railway domain, no trailing slash) and `MEDIA_SECRET` (identical to Railway's),
and **redeploy** — Vercel only picks up env changes on a new deployment.

### ALLOWED_ORIGINS and preview deployments

Vercel gives every preview deployment its own hostname, so a fixed list only
covers the URLs you name. List your production and branch domains:

```
https://your-app.vercel.app,https://pix-agent-git-main-<team>.vercel.app
```

If you test video on preview deploys, set it to `*`. That is not as reckless
as it looks here: CORS is not the security boundary — the `X-Media-Token`
HMAC is, and a token can only be obtained from your own Vercel app. CORS is
defence in depth.

### Cost

The container is always-on and idles at roughly $5/month on Railway's Hobby
plan, plus usage during encodes. It shares that plan with the upscaler.

## Deploying the whole app to Railway (alternative)

Not required for video. Worth doing if the three-way backend duplication
becomes painful: `server.mjs` is a strict superset of `api/` (it routes all
11 endpoints plus `/api/scrape` and `/api/twitter/post`), so running it means
ONE backend instead of three. Today `EDITORIAL_SYSTEM_PROMPT`, `clampBullet`,
`repairBullets`, `clampTweet` and `buildEnhancePrompt` all exist in two
places, and every editorial change has to be applied twice.

The whole app becomes three services in **one Railway project**, sharing a
project-level variable group.

### Service 1 — the app (`server.mjs`)

1. **New Project → Deploy from GitHub repo** → `DridhaTeamHQ/pixAgent`
2. **Settings → Root Directory:** `.` (default)
3. Railway reads `railway.json`: Nixpacks build, `node server.mjs`,
   healthcheck on `/health`. No build step and no Dockerfile needed —
   `package.json` already declares `"start": "node server.mjs"`.
4. **Variables** — the same set Vercel used:

   | Name | Required for |
   |---|---|
   | `OPENAI_API_KEY` | article writer, captions, vision |
   | `SHORTLY_AGENT_AUTH_SECRET` | Shortly Agents access gate |
   | `PEXELS_API_KEY` | stock images (otherwise that source is skipped) |
   | `FAL_KEY` | Flux image generation |
   | `IMAGE_QUALITY` | `medium` |
   | `UPSCALER_URL` / `UPSCALER_SECRET` | service 2 |
   | `MEDIA_URL` / `MEDIA_SECRET` | service 3 |

   Do **not** set `PORT` — Railway injects it and `server.mjs` reads it.

5. **Settings → Networking → Generate Domain**

### Service 2 — upscaler

Root Directory `upscaler`. See [upscaler/README.md](upscaler/README.md).

### Service 3 — media (video)

Root Directory `media`. See [media/README.md](media/README.md). Set
`ALLOWED_ORIGINS` to the app's Railway domain — the browser calls this
service directly.

### Verify before cutting over

```bash
curl https://YOUR-APP.up.railway.app/health
```

Expect `{"ok":true,...}` with each feature flag `true` for whatever you
configured. Then load the app and check: a scrape, an article generation,
and a video export.

### After it's verified

Delete `api/`, `netlify/functions/`, `netlify.toml` and `vercel.json`. That
removes ~2,200 lines of duplicated backend and leaves `server.mjs` as the
single implementation. Keeping them around preserves exactly the
double-editing problem the move is meant to solve.

### Caching note

Vercel's CDN handled static caching. `server.mjs` now does it itself:
`no-cache` + `Last-Modified` on HTML/JS/CSS (revalidate every load, answer
304 with an empty body — never stale, but `app.js` costs 0 bytes on repeat
visits) and `max-age=86400` on images and fonts.

## Local development

```bash
npm install
npm run dev          # node --watch server.mjs (port 3000)
```

The Node server serves both `public/` and `/api/*` routes via a single
process. The `api/*.js` files are NOT used in this mode — they are
serverless functions that only run on Vercel.

## Local dev with Vercel CLI (optional)

To test the actual serverless functions locally before pushing:

```bash
npm install -g vercel
vercel dev
```

This emulates the Vercel runtime and uses `api/*.js`. It reads `.env`
automatically.

## What runs where

| Endpoint | Local dev | Vercel |
|---|---|---|
| `/` (HTML, JS, CSS) | server.mjs serves from `public/` | Vercel rewrites to `/public/*` |
| `/api/*` | server.mjs route handlers | `api/*.js` serverless functions |
