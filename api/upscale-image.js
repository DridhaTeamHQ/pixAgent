// AI background enhancer — OpenAI gpt-image-1 image edit.
// Accepts a raw PNG/JPEG body, sends it to /v1/images/edits with an
// "enhance, do not change content" prompt, returns { image: dataUrl }.
//
// Note: gpt-image-1 REGENERATES the image (max 1536px on the long edge).
// It sharpens and cleans up compression artifacts well, but faces and small
// text can shift subtly — the UI labels this as AI Enhance, and the user can
// always re-pick the original.

import { readRawBody } from "../lib/http.js";

export const config = {
  api: {
    bodyParser: false,        // we read the raw image bytes ourselves
    responseLimit: "12mb",
  },
};

const ENHANCE_PROMPT =
  "Enhance this news photograph: increase sharpness, detail and clarity, remove compression artifacts and noise, improve lighting and colour balance. Keep the content, composition, faces, text and all elements EXACTLY identical to the original. Do not add, remove or alter anything.";

export default async function handler(req, res) {
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed." });
    return;
  }

  const apiKey = process.env.OPENAI_API_KEY || "";
  if (!apiKey) {
    res.status(503).json({ error: "OPENAI_API_KEY not set on server." });
    return;
  }

  try {
    const buffer = await readRawBody(req, 10 * 1024 * 1024);
    if (buffer.length < 100) {
      res.status(400).json({ error: "Empty or invalid image body." });
      return;
    }
    const mime = req.headers["content-type"]?.includes("jpeg") ? "image/jpeg" : "image/png";

    // Landscape/portrait hint → pick the closest gpt-image-1 output size.
    // (The model only supports these three; "auto" lets it choose otherwise.)
    const sizeHint = (req.headers["x-image-orientation"] || "").toString();
    const size =
      sizeHint === "landscape" ? "1536x1024" :
      sizeHint === "portrait"  ? "1024x1536" :
      "auto";

    // Cost-effective defaults. gpt-image-1 quality drives ~15× the price:
    //   low ≈ $0.016   medium ≈ $0.06   high ≈ $0.25   (per 1024×1536)
    // The background sits behind a dark gradient + headline, so "low" is
    // plenty. Override via IMAGE_QUALITY env (low | medium | high).
    const quality = (process.env.IMAGE_QUALITY || "low").toLowerCase();

    const form = new FormData();
    form.append("model", "gpt-image-1");
    form.append("prompt", ENHANCE_PROMPT);
    form.append("size", size);
    form.append("quality", quality);
    form.append("image", new Blob([buffer], { type: mime }), mime === "image/jpeg" ? "input.jpg" : "input.png");

    const t0 = Date.now();
    const aiRes = await fetch("https://api.openai.com/v1/images/edits", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });

    if (!aiRes.ok) {
      const errText = await aiRes.text().catch(() => "");
      console.error(`gpt-image-1 ${aiRes.status}:`, errText.slice(0, 400));
      res.status(502).json({ error: `OpenAI image ${aiRes.status}`, detail: errText.slice(0, 300) });
      return;
    }

    const data = await aiRes.json();
    const b64 = data?.data?.[0]?.b64_json;
    if (!b64) {
      res.status(502).json({ error: "OpenAI returned no image data." });
      return;
    }

    console.log(`AI enhance done in ${Date.now() - t0}ms (${Math.round(b64.length * 0.75 / 1024)} KB out)`);
    res.status(200).json({ image: `data:image/png;base64,${b64}` });
  } catch (err) {
    console.error("upscale-image error:", err);
    res.status(500).json({ error: err.message || "Image enhance failed." });
  }
}
