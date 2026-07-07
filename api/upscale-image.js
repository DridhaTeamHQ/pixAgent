// AI background enhancer — context-aware, identity-preserving.
//
// Two-stage pipeline:
//   1. gpt-4o-mini (vision) looks at the photo and writes a precise
//      description — who is in it, notable faces, text, setting. (~$0.001)
//   2. gpt-image-1 (quality=high, input_fidelity=high) performs the
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
};

// Stage-1 vision instruction — a tight, factual inventory of the photo.
const VISION_PROMPT =
  "You are assisting a photo-restoration pipeline for a news organisation. " +
  "Describe this photograph in 2-4 sentences, factually and precisely: the people " +
  "(count, apparent age, facial hair, glasses, expressions, clothing), any visible text, " +
  "logos or signage (quote them exactly), the setting, and the lighting. " +
  "Do NOT guess names. Output only the description.";

// Stage-2 edit prompt — context + strict preservation rules.
function buildEnhancePrompt(description, headline) {
  return [
    "Professional photo restoration of a REAL news photograph.",
    description ? `CONTEXT — the photo shows: ${description}` : "",
    headline ? `It accompanies this news story: "${headline}".` : "",
    "",
    "TASK: upscale and enhance only — recover fine detail, increase sharpness,",
    "remove compression artifacts and noise, correct exposure and colour balance.",
    "",
    "ABSOLUTE RULES:",
    "- Every person's face must stay PIXEL-FAITHFUL to the original identity:",
    "  same facial structure, skin texture, wrinkles, expression and age.",
    "  Do NOT beautify, smooth skin, or idealise anyone.",
    "- Reproduce all text, logos and signage exactly as written.",
    "- Identical composition, framing, colours and content.",
    "- Add nothing. Remove nothing. This is journalism, not art.",
  ].filter(Boolean).join("\n");
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

    // Landscape/portrait hint → closest gpt-image-1 output size.
    const sizeHint = (req.headers["x-image-orientation"] || "").toString();
    const size =
      sizeHint === "landscape" ? "1536x1024" :
      sizeHint === "portrait"  ? "1024x1536" :
      "auto";

    // Identity preservation beats cost for news photos — default high.
    const quality = (process.env.IMAGE_QUALITY || "high").toLowerCase();

    const t0 = Date.now();

    // Stage 1 — understand the image (cheap, fails soft)
    const description = await describeImage(apiKey, buffer, mime);
    if (description) console.log(`vision context (${Date.now() - t0}ms): ${description.slice(0, 140)}…`);

    // Stage 2 — context-aware enhancement
    const form = new FormData();
    form.append("model", "gpt-image-1");
    form.append("prompt", buildEnhancePrompt(description, headline));
    form.append("size", size);
    form.append("quality", quality);
    form.append("input_fidelity", "high");   // OpenAI's face/identity preservation control
    form.append("image", new Blob([buffer], { type: mime }), mime === "image/jpeg" ? "input.jpg" : "input.png");

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

    console.log(`AI enhance done in ${Date.now() - t0}ms (quality=${quality}, ${Math.round(b64.length * 0.75 / 1024)} KB out)`);
    res.status(200).json({ image: `data:image/png;base64,${b64}`, context: description });
  } catch (err) {
    console.error("upscale-image error:", err);
    res.status(500).json({ error: err.message || "Image enhance failed." });
  }
}
