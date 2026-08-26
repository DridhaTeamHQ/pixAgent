// Direct GPT Image enhancement endpoint.
//
// One request goes straight from the source photograph to gpt-image-1.5.
// There is no separate vision pass, self-hosted upscaler, outpainting step,
// or model fallback. input_fidelity=high and an unchanged source orientation
// reduce unnecessary face reconstruction.

import { readRawBody } from "../lib/http.js";

export const config = {
  api: {
    bodyParser: false,
    responseLimit: "16mb",
  },
  maxDuration: 300,
};

const IMAGE_ENHANCE_PROMPT = [
  "Upscale and restore this exact real news photograph.",
  "Preserve the original composition, crop, camera perspective, lighting, colours and background.",
  "Preserve every person's exact identity, facial geometry, expression, age, pores, wrinkles, facial hair and natural skin texture.",
  "Remove only compression artifacts and sensor noise; recover realistic photographic detail with restrained sharpening.",
  "Do not smooth, airbrush, beautify, stylise, repaint or reconstruct skin. Avoid waxy, plastic, clay-like or illustrated faces.",
  "Do not add, remove or move people or objects. Do not add text, logos, captions, watermarks or graphics.",
  "Return a natural documentary photograph, not AI artwork.",
].join("\n");

function imageSizeForOrientation(orientation) {
  if (orientation === "landscape") return "1536x1024";
  if (orientation === "portrait") return "1024x1536";
  return "1024x1024";
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
    const orientation = (req.headers["x-image-orientation"] || "").toString();
    const size = imageSizeForOrientation(orientation);
    const quality = (process.env.IMAGE_QUALITY || "high").toLowerCase();
    const model = process.env.GPT_IMAGE_MODEL || "gpt-image-1.5";

    const form = new FormData();
    form.append("model", model);
    form.append("prompt", IMAGE_ENHANCE_PROMPT);
    form.append("size", size);
    form.append("quality", quality);
    form.append("input_fidelity", "high");
    form.append("image", new Blob([buffer], { type: mime }), mime === "image/jpeg" ? "input.jpg" : "input.png");

    const startedAt = Date.now();
    const aiRes = await fetch("https://api.openai.com/v1/images/edits", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });

    if (!aiRes.ok) {
      const errText = await aiRes.text().catch(() => "");
      console.error(`${model} ${aiRes.status}:`, errText.slice(0, 400));
      res.status(502).json({ error: `OpenAI image ${aiRes.status}`, detail: errText.slice(0, 300) });
      return;
    }

    const data = await aiRes.json();
    const b64 = data?.data?.[0]?.b64_json;
    if (!b64) {
      res.status(502).json({ error: "OpenAI returned no image data." });
      return;
    }

    console.log(`AI enhance done in ${Date.now() - startedAt}ms (${model}, ${size}, quality=${quality})`);
    res.status(200).json({ image: `data:image/png;base64,${b64}`, engine: model });
  } catch (err) {
    console.error("upscale-image error:", err);
    res.status(500).json({ error: err.message || "Image enhance failed." });
  }
}
