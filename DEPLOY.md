# Deploying Pix Post Builder

Pix can run in two shapes. **Railway is now the recommended target** — see
[Deploying to Railway](#deploying-to-railway-recommended) below. The Vercel
instructions that follow still work and are kept until the Railway cutover
is verified.

**Why Railway:** `server.mjs` is a strict superset of `api/` — it routes all
11 serverless endpoints plus two more (`/api/scrape`, `/api/twitter/post`).
Running it means ONE backend implementation instead of three (`api/`,
`server.mjs`, `netlify/functions/`), which today all carry duplicate copies
of `EDITORIAL_SYSTEM_PROMPT`, `clampBullet`, `repairBullets`, `clampTweet`,
`buildEnhancePrompt` and more. Every editorial change currently has to be
applied twice or local silently diverges from production.

Railway also removes the two limits that shaped the video feature: the
4.5 MB serverless request-body cap and the 300s function timeout.

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

## Deploying to Railway (recommended)

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
