// Direct GPT Image enhancement endpoint.
//
// One request goes straight from the source photograph to gpt-image-1.5.
// There is no separate vision pass, self-hosted upscaler, outpainting step,
// or model fallback. Framing and detail are selected by the model.

import { readRawBody } from "../lib/http.js";
import {
  GPT_IMAGE_ENHANCE_MODEL,
  GPT_IMAGE_ENHANCE_QUALITY,
  GPT_IMAGE_ENHANCE_SIZE,
  IMAGE_ENHANCE_PROMPT,
} from "../lib/ai-enhance.js";

export const config = {
  api: {
    bodyParser: false,
    responseLimit: "16mb",
  },
  maxDuration: 300,
};

function openAIImageError(raw, status) {
  try {
    const parsed = JSON.parse(raw);
    const error = parsed?.error || {};
    return {
      message: String(error.message || `OpenAI image ${status}`).slice(0, 300),
      code: String(error.code || "").slice(0, 100),
    };
  } catch {
    return { message: `OpenAI image ${status}`, code: "" };
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
    const model = GPT_IMAGE_ENHANCE_MODEL;

    const form = new FormData();
    form.append("model", model);
    form.append("prompt", IMAGE_ENHANCE_PROMPT);
    form.append("size", GPT_IMAGE_ENHANCE_SIZE);
    form.append("quality", GPT_IMAGE_ENHANCE_QUALITY);
    form.append("image", new Blob([buffer], { type: mime }), mime === "image/jpeg" ? "input.jpg" : "input.png");

    const startedAt = Date.now();
    const aiRes = await fetch("https://api.openai.com/v1/images/edits", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });

    if (!aiRes.ok) {
      const errText = await aiRes.text().catch(() => "");
      const upstream = openAIImageError(errText, aiRes.status);
      console.error(`${model} ${aiRes.status}:`, errText.slice(0, 400));
      res.status(502).json({
        error: upstream.message,
        code: upstream.code || undefined,
        upstreamStatus: aiRes.status,
      });
      return;
    }

    const data = await aiRes.json();
    const b64 = data?.data?.[0]?.b64_json;
    if (!b64) {
      res.status(502).json({ error: "OpenAI returned no image data." });
      return;
    }

    console.log(`AI enhance done in ${Date.now() - startedAt}ms (${model}, framing=auto, detail=auto)`);
    res.status(200).json({
      image: `data:image/png;base64,${b64}`,
      engine: model,
      framing: GPT_IMAGE_ENHANCE_SIZE,
      detail: GPT_IMAGE_ENHANCE_QUALITY,
    });
  } catch (err) {
    console.error("upscale-image error:", err);
    res.status(500).json({ error: err.message || "Image enhance failed." });
  }
}
