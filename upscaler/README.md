# Pix AI Upscaler (Railway)

Self-hosted, pixel-faithful image enhancer: **CodeFormer** (face restoration)
+ **Real-ESRGAN** (background upscale). CPU-only, no GPU. Runs on Railway; the
Pix backend calls it first and falls back to gpt-image-1.5 if it's unavailable.

Unlike gpt-image, this **upscales the real photo** — it never regenerates or
invents faces, so it's safe for news photos.

## Deploy on Railway

1. Railway → **New Project → Deploy from GitHub repo** → pick `DridhaTeamHQ/pixAgent`.
2. In the service settings set **Root Directory** to `upscaler` (so Railway builds this folder's Dockerfile, not the Node app).
3. **Variables** (Service → Variables):
   | Name | Value |
   |---|---|
   | `UPSCALER_SECRET` | a long random string (must match Pix backend) |
   | `CODEFORMER_FIDELITY` | `0.7` (optional; higher = more faithful, lower = prettier) |
   | `UPSCALE` | `2` (optional) |
4. Deploy. First build is slow (downloads PyTorch + model weights, ~5–8 min).
5. **Networking → Generate Domain** → copy the public URL, e.g.
   `https://pix-upscaler-production.up.railway.app`.
6. Smoke test: `GET https://<domain>/health` → `{"ok": true, ...}`.

## Wire it into Pix

Add to the Pix env (local `.env` **and** Vercel → Settings → Environment Variables):

```
UPSCALER_URL=https://<your-railway-domain>
UPSCALER_SECRET=<same long random string as above>
```

That's it — AI Enhance now uses Railway. If `UPSCALER_URL` is unset, or the
service errors/times out, Pix automatically falls back to gpt-image-1.5.

## Notes

- **Speed**: CPU inference of a single-face 1536px photo is ~30–90 s depending
  on Railway plan (more vCPU = faster). The Pix frontend already caps the sent
  image at 1536px on the long edge.
- **Vercel timeout**: the Pix `/api/upscale-image` proxy waits for Railway.
  Vercel Hobby caps functions at 60 s; if a job runs longer it falls back to
  gpt-image. Vercel Pro allows up to 300 s (the route requests `maxDuration:
  300`). For consistently long jobs, upgrade the plan or lower `UPSCALE`.
- **Cost**: flat Railway compute (fits a Hobby plan for low volume) instead of
  ~$0.06–0.08 per gpt-image enhance.

## Local run

```bash
cd upscaler
docker build -t pix-upscaler .
docker run -p 8000:8000 -e UPSCALER_SECRET=dev pix-upscaler
# then: curl -X POST --data-binary @photo.jpg -H "X-Secret: dev" http://localhost:8000/enhance --output out.png
```
