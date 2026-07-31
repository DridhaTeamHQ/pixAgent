# Deploying Pix Post Builder to Vercel

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
