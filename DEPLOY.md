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
`gpt-image-2` using the OpenAI Images edit endpoint.

- Enhancement output proportions come from the actual PNG/JPEG source, never
  the poster aspect. Dimensions are rounded to GPT Image's 16-pixel grid and
  kept near 1.8 MP (at most 2 MP). Ratios beyond 3:1 / 1:3 are rejected instead
  of silently changing the composition. Legacy `X-Poster-Aspect` is ignored.
- High-quality output is used with a conservative prompt that explicitly
  forbids invented pores, skin grain, beard hairs, micro-contrast, and halos.
- The prompt forbids reframing, outpainting, inset copies and duplicated scenes.
  Pix retains the existing zoom, pan and normalized focal point after enhancement.
  An output aspect change greater than 1% is rejected, as are old server replies
  that do not declare the new source-preserving request contract. This checks
  dimensions, not visual content; GPT can still alter details, so review/undo
  remains necessary.
- Mark maps, diagrams and annotated screenshots with the image-type checkbox.
  It enables factual-layout guidance and blocks extension in the UI and API.
  It is a manual classification, not automatic map detection.
- There is no vision-analysis pass, Railway upscaler service, CodeFormer,
  Real-ESRGAN, SwinIR, aspect-ratio outpainting, or fallback image model.

Each enhancement consumes OpenAI image credits. The Enhance route deliberately
locks the model and quality so stale Railway variables cannot override the
intended behavior.

## Zoom and image extension

- Ordinary zoom stops at 100%: the widest crop that still covers the poster.
  Older zoom values below 100% are clamped when rendered. Both poster and text
  preview draw a single image; neither uses a duplicate photo to fill gaps.
- **Extend image with AI** calls `POST /api/extend-image` separately and only
  on click. It fits the entire current source photo into 85% of the selected
  output canvas and asks GPT Image to outpaint the surrounding margins.
- A same-size alpha mask marks the source as protected and the margins as
  editable. No poster text, logo, filters or composited backdrop is sent.
  Mask guidance is not a pixel-perfect guarantee: review the result, especially
  faces and newly generated surroundings, before publishing a news image.
- The returned image replaces the previous one as a single layer. Undo restores
  the previous image and crop. Failed or stale requests never replace it.
- This uses the existing OpenAI key and model, not another upscaler or service.
  Railway and the legacy serverless route share the same extension handler.
- Map/diagram mode blocks this action before an OpenAI call. Generating extra
  terrain, roads or labels is not an acceptable way to expand a factual map.

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

Then test a scrape, article generation, AI Enhance, image extension/undo, and video export.

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
