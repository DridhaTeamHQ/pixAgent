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
   | `OPENAI_API_KEY` | AI tweet captions |
   | `PEXELS_API_KEY` | Stock background images |

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
