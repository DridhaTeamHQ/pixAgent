# Deploying Pix Post Builder

## Architecture

Two Railway services:

| Service | Root Directory | What it is |
|---|---|---|
| **app** | `.` | `server.mjs` — frontend, every `/api/*` route, **and the video pipeline** |
| **upscaler** | `upscaler` | AI Enhance (CodeFormer + Real-ESRGAN) — **not deployed in production**, see below |

## Upscaling in production

Production does **not** run the upscaler service and does **not** call
gpt-image. Both cost money per image, and image spend was the largest line on
the bill. Upscaling goes to the **Pix Upscaler** GPT instead:

<https://chatgpt.com/g/g-6a798c3876bc8191b5bd3deae1b983f8-pix-upscaler>

**This is the default and needs no configuration.** The link is compiled in
rather than read from a variable, so a fresh deploy cannot start billing for
images because someone forgot to set one.

The round trip is: **Copy image for upscaling** in Pix → paste into the GPT →
copy what it returns → **Paste image** back in Pix → download the poster with
the logo, text and date tag. Cost to this deployment: zero.

That first button matters more than it looks. Without it the user arrives at
the GPT with whatever was last on their clipboard — usually the article URL
they just scraped — and <kbd>Ctrl</kbd>+<kbd>V</kbd> pastes a link instead of
a photo. It writes the background to the clipboard as a PNG at **full
resolution**, since downscaling first would discard the detail the GPT is
being asked to recover.

Two things follow from it, and the second is the one that matters:

1. The UI swaps the *AI Enhance* button and its strength slider for the copy
   button, a link to the GPT, and the four steps.
2. **`/api/upscale-image` refuses with 503 before reading the request body.**
   Hiding a button is not a spending control — a stale tab or a direct POST
   would still bill. The server-side refusal is what makes the saving real.

The `upscaler` service and `UPSCALER_URL` remain supported for local work;
they are simply unset in production.

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
| `YTDLP_COOKIES` | for YouTube | base64 `cookies.txt` from a **throwaway** account. Free, but expires in weeks–months |
| `YTDLP_PROXY` | for YouTube | residential proxy URL, e.g. `http://user:pass@host:port`. Costs money, but never expires and risks no account |
| `UPSCALER_GPT_URL` | **no** | The Pix Upscaler GPT is baked in. Only set this to point at a different GPT, or `off` to restore the in-app enhance |
| `UPSCALER_URL` | only after `=off` | upscaler domain, no trailing slash |
| `UPSCALER_SECRET` | only after `=off` | must match the upscaler service |
| `PEXELS_API_KEY` | optional | stock images. Unset = that source is skipped |
| `FAL_KEY` | optional | Flux image generation (last-resort, paid) |
| `IMAGE_QUALITY` | optional | `medium` (default). low ≈ $0.016, medium ≈ $0.034, high ≈ $0.25 per image. Irrelevant when `UPSCALER_GPT_URL` is set |
| `MAX_CLIP_SECONDS` | optional | `90` |
| `MAX_UPLOAD_BYTES` | optional | `314572800` (300 MB) |
| `TWITTER_API_KEY` etc. | optional | only for `/api/twitter/post` |

Set on the **upscaler** service: `UPSCALER_SECRET` (plus its own options —
see [upscaler/README.md](upscaler/README.md)).

**Do not set `PORT`.** Railway injects it; hard-coding it makes the container
unreachable behind their proxy.

## Why YouTube needs cookies or a proxy

YouTube judges requests by IP reputation, and every cloud host — Railway
included — sits in a flagged datacenter range. Measured against the live
deployment: even with a JS runtime and all five player clients tried, an
anonymous fetch is refused with "Sign in to confirm you're not a bot".

Two fixes, and they solve it differently:

| | `YTDLP_COOKIES` | `YTDLP_PROXY` |
|---|---|---|
| How | proves an account is behind the request | removes the reason for the challenge |
| Cost | free | ~$1–15/GB |
| Expires | weeks to months | never |
| Risk | the account can be banned | none |

Cookies are the quick fix. A residential proxy (IPRoyal, Bright Data, etc.)
is the right answer for anything public — nothing to re-export on a
schedule, and no Google account exposed. Set both and both are applied.

**Uploading a file needs neither** and never breaks.

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
 "features":{"openai":true,"upscaler":false,"upscalerGpt":true,
             "gptImageFallback":false,"ffmpeg":true,
             "ytdlp":true,"ytdlpCookies":true,"pexels":true}}
```

- `upscalerGpt` **true** with `upscaler` and `gptImageFallback` **false** is
  the intended production state: upscaling runs on the user's ChatGPT account
  and no image spend is possible. `upscaler:false` here is not a fault.
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
