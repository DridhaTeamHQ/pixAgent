// AI background enhancer — context-aware, identity-preserving.
//
// Two-stage pipeline:
//   1. gpt-4o-mini (vision) looks at the photo and writes a precise
//      description — who is in it, notable faces, text, setting. (~$0.001)
//   2. gpt-image-1.5 (quality from IMAGE_QUALITY, input_fidelity=high) does
//      enhancement with that description embedded in the prompt, so the
//      model knows exactly what it is looking at and what it must NOT
//      change. input_fidelity=high is OpenAI's control for preserving
//      faces/identity in edits — essential for news photos.
//
// Accepts a raw PNG/JPEG body (+ optional X-Headline header for extra
// story context), returns { image: dataUrl, context: description }.

import { readRawBody } from "../lib/http.js";

export const config = {
  api: {
    bodyParser: false,        // we read the raw image bytes ourselves
    responseLimit: "16mb",
  },
  maxDuration: 300,           // allow the Railway upscale to finish (Vercel Pro)
};

// Primary engine: the self-hosted CodeFormer + Real-ESRGAN service on Railway
// (pixel-faithful, never regenerates faces). Returns a PNG data URL, or null
// if the service isn't configured / errors / times out — caller then falls
// back to gpt-image-1.5.
async function tryRailwayUpscale(buffer, mime) {
  const base = (process.env.UPSCALER_URL || "").replace(/\/+$/, "");
  if (!base) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 285000);
  try {
    const r = await fetch(`${base}/enhance`, {
      method: "POST",
      headers: {
        "Content-Type": mime,
        "X-Secret": process.env.UPSCALER_SECRET || "",
      },
      body: buffer,
      signal: ctrl.signal,
    });
    if (!r.ok) {
      console.warn(`Railway upscaler ${r.status} — falling back to gpt-image`);
      return null;
    }
    const out = Buffer.from(await r.arrayBuffer());
    if (out.length < 1000) return null;
    return `data:image/png;base64,${out.toString("base64")}`;
  } catch (e) {
    console.warn("Railway upscaler unreachable — falling back to gpt-image:", e.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Stage-1 vision instruction — a tight, factual inventory of the photo.
const VISION_PROMPT =
  "You are assisting a photo-restoration pipeline for a news organisation. " +
  "Describe this photograph in 2-4 sentences, factually and precisely: the people " +
  "(count, apparent age, facial hair, glasses, expressions, clothing), any visible text, " +
  "logos or signage (quote them exactly), the setting, and the lighting. " +
  "Do NOT guess names. Output only the description.";

// Stage-2 edit prompt — context + strict preservation rules. When the target
// canvas ratio differs from the source photo, the model must EXTEND the scene
// (outpaint) rather than crop or distort the subject.
function buildEnhancePrompt(description, headline, ratioLabel) {
  return [
    "Professional photo restoration of a REAL news photograph.",
    description ? `CONTEXT — the photo shows: ${description}` : "",
    headline ? `It accompanies this news story: "${headline}".` : "",
    "",
    "TASK: upscale and enhance — recover fine detail, increase sharpness,",
    "remove compression artifacts and noise, correct exposure and colour balance.",
    ratioLabel
      ? `The output canvas is ${ratioLabel}. If the original photo has a different shape, EXTEND the scene naturally (continue the background/setting) to fill the ${ratioLabel} frame — keep the main subject fully visible, at the same relative scale, never cropped, stretched or distorted.`
      : "",
    "",
    "ABSOLUTE RULES:",
    "- Every person's face must stay PIXEL-FAITHFUL to the original identity:",
    "  same facial structure, skin texture, wrinkles, expression and age.",
    "  Do NOT beautify, smooth skin, or idealise anyone.",
    "- Reproduce all text, logos and signage exactly as written.",
    "- The original content itself is unchanged — only the surrounding scene",
    "  may be extended to fill the frame. Add no new people or objects of",
    "  interest. This is journalism, not art.",
  ].filter(Boolean).join("\n");
}

// Map the poster's aspect ratio to the closest gpt-image output size.
function sizeForRatio(ratio, orientationHint) {
  switch (ratio) {
    case "9:16":
    case "4:5":  return "1024x1536";
    case "1:1":  return "1024x1024";
    case "16:9": return "1536x1024";
  }
  // No ratio supplied — fall back to the source image's own orientation.
  if (orientationHint === "landscape") return "1536x1024";
  if (orientationHint === "portrait")  return "1024x1536";
  return "auto";
}

// Stage 1: ask gpt-4o-mini what the image actually contains.
async function describeImage(apiKey, buffer, mime) {
  try {
    const dataUrl = `data:${mime};base64,${buffer.toString("base64")}`;
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [{
          role: "user",
          content: [
            { type: "text", text: VISION_PROMPT },
            { type: "image_url", image_url: { url: dataUrl, detail: "low" } },
          ],
        }],
        temperature: 0.2,
        max_tokens: 220,
      }),
    });
    if (!r.ok) {
      console.warn(`vision describe failed (${r.status}) — enhancing without context`);
      return "";
    }
    const data = await r.json();
    return (data?.choices?.[0]?.message?.content || "").trim();
  } catch (e) {
    console.warn("vision describe error — enhancing without context:", e.message);
    return "";
  }
}

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
    if (buffer.length < 1000) {
      res.status(400).json({ error: "Empty or invalid image body." });
      return;
    }
    const mime = req.headers["content-type"]?.includes("jpeg") ? "image/jpeg" : "image/png";
    const headline = decodeURIComponent(req.headers["x-headline"] || "").trim().slice(0, 200);

    // PRIMARY: self-hosted CodeFormer + Real-ESRGAN on Railway (pixel-faithful).
    const railwayT0 = Date.now();
    const railwayImage = await tryRailwayUpscale(buffer, mime);
    if (railwayImage) {
      console.log(`AI enhance via Railway (codeformer) in ${Date.now() - railwayT0}ms`);
      res.status(200).json({ image: railwayImage, engine: "codeformer" });
      return;
    }
    // else fall through to gpt-image-1.5 ↓

    // The SELECTED POSTER RATIO drives the output size, so a 9:16 poster
    // gets a portrait image (outpainted if the source is landscape) instead
    // of a landscape image that the canvas then crops to shreds.
    const posterRatio = (req.headers["x-poster-ratio"] || "").toString();
    const sizeHint = (req.headers["x-image-orientation"] || "").toString();
    const size = sizeForRatio(posterRatio, sizeHint);

    // Default medium: input_fidelity=high (kept) does the face preservation;
    // quality mostly buys texture. high≈$0.25, medium≈$0.06, low≈$0.016.
    const quality = (process.env.IMAGE_QUALITY || "medium").toLowerCase();

    const t0 = Date.now();

    // Stage 1 — understand the image (cheap, fails soft)
    const description = await describeImage(apiKey, buffer, mime);
    if (description) console.log(`vision context (${Date.now() - t0}ms): ${description.slice(0, 140)}…`);

    // Stage 2 — context-aware enhancement.
    // gpt-image-1.5 first; automatic fallback to gpt-image-1 if the account
    // doesn't have the newer model.
    const prompt = buildEnhancePrompt(description, headline, posterRatio);
    const callEdit = async (model) => {
      const form = new FormData();
      form.append("model", model);
      form.append("prompt", prompt);
      form.append("size", size);
      form.append("quality", quality);
      form.append("input_fidelity", "high");   // OpenAI's face/identity preservation control
      form.append("image", new Blob([buffer], { type: mime }), mime === "image/jpeg" ? "input.jpg" : "input.png");
      return fetch("https://api.openai.com/v1/images/edits", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
      });
    };

    let modelUsed = "gpt-image-1.5";
    let aiRes = await callEdit(modelUsed);
    if (!aiRes.ok && [400, 403, 404].includes(aiRes.status)) {
      const firstErr = await aiRes.text().catch(() => "");
      console.warn(`gpt-image-1.5 unavailable (${aiRes.status}) — falling back to gpt-image-1:`, firstErr.slice(0, 160));
      modelUsed = "gpt-image-1";
      aiRes = await callEdit(modelUsed);
    }

    if (!aiRes.ok) {
      const errText = await aiRes.text().catch(() => "");
      console.error(`${modelUsed} ${aiRes.status}:`, errText.slice(0, 400));
      res.status(502).json({ error: `OpenAI image ${aiRes.status}`, detail: errText.slice(0, 300) });
      return;
    }

    const data = await aiRes.json();
    const b64 = data?.data?.[0]?.b64_json;
    if (!b64) {
      res.status(502).json({ error: "OpenAI returned no image data." });
      return;
    }

    console.log(`AI enhance done in ${Date.now() - t0}ms (${modelUsed}, ${size}, quality=${quality}, ${Math.round(b64.length * 0.75 / 1024)} KB out)`);
    res.status(200).json({ image: `data:image/png;base64,${b64}`, context: description, engine: modelUsed });
  } catch (err) {
    console.error("upscale-image error:", err);
    res.status(500).json({ error: err.message || "Image enhance failed." });
  }
}
