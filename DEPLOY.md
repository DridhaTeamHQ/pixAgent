# Deploying Pix Post Builder

## Architecture

Pix runs as one Railway service from the repository root:

| Service | Root directory | Responsibility |
|---|---|---|
| **app** | `.` | Frontend, all `/api/*` routes, direct GPT Image enhancement, and video processing |

`server.mjs` serves the frontend and API. The root `Dockerfile` supplies Node,
ffmpeg, and yt-dlp. Railway must use the Dockerfile build rather than Nixpacks.

## AI Enhance

`POST /api/upscale-image` sends the source photograph directly to
`gpt-image-1.5` using the OpenAI Images edit endpoint.

- `size=auto` lets the model choose the most appropriate framing.
- `quality=auto` lets the model choose the appropriate render detail.
- The prompt explicitly preserves identity, pores, wrinkles, facial hair, and
  natural skin texture while rejecting waxy, plastic, or clay-like rendering.
- There is no vision-analysis pass, Railway upscaler service, CodeFormer,
  Real-ESRGAN, SwinIR, aspect-ratio outpainting, or fallback image model.

Each enhancement consumes OpenAI image credits. The Enhance route deliberately
locks the model and both automatic output settings so stale Railway variables
cannot override the intended behavior.

## Environment variables

Set these on the Railway app service:

| Name | Required? | Purpose |
|---|---|---|
| `OPENAI_API_KEY` | **yes** | Article generation, captions, image analysis, and AI Enhance |
| `SHORTLY_AGENT_AUTH_SECRET` | **yes** | Shortly Agents access gate; unset leaves the app open |
| `YTDLP_COOKIES` | for protected video sources | Base64 cookies.txt from a throwaway account |
| `YTDLP_PROXY` | optional | Residential proxy for video extraction |
| `PEXELS_API_KEY` | optional | Stock images |
| `FAL_KEY` | optional | Flux image generation |
| `MAX_CLIP_SECONDS` | optional | Defaults to `90` |
| `MAX_UPLOAD_BYTES` | optional | Defaults to 300 MB |
| `TWITTER_API_KEY` and related keys | optional | X/Twitter publishing |

Do not set `PORT`; Railway injects it.

## Deploy

1. In Railway, create a project from `DridhaTeamHQ/pixAgent`.
2. Set the root directory to `.`.
3. Add the required environment variables.
4. Generate a public domain under Networking.
5. Wait for `/health` to report `ok: true`.

## Verify

```bash
curl https://YOUR-APP.up.railway.app/health
```

The response should include:

```json
{
  "ok": true,
  "features": {
    "openai": true,
    "gptImageEnhance": true,
    "ffmpeg": true,
    "ytdlp": true
  }
}
```

Then test a scrape, article generation, AI Enhance, and video export.

## Local development

```bash
npm install
npm run dev
```

The app runs at `http://localhost:3000`. Restart it after changing `.env`.

## Repository layout

```text
pixAgent/
|-- Dockerfile
|-- railway.json
|-- server.mjs
|-- public/
|-- lib/
|-- api/                 # legacy Vercel mirror
|-- netlify/             # legacy Netlify mirror
`-- vercel.json
```
