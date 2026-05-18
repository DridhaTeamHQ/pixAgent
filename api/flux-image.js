import { setCors, handlePreflight } from "../lib/http.js";

export const config = {
  maxDuration: 60,
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  setCors(res);

  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed." });
    return;
  }

  try {
    const falKey = process.env.FAL_KEY || "";
    if (!falKey) {
      res.status(503).json({ error: "FAL_KEY is missing." });
      return;
    }

    const query = (req.query?.query || "").toString().trim();
    const context = (req.query?.context || "").toString().trim();
    if (!query) {
      res.status(400).json({ error: "A prompt is required." });
      return;
    }

    const result = await runFalFlux(falKey, buildFluxPrompt(query, context));
    const images = (result.images || [])
      .map((image, index) => {
        const url = image.url;
        return {
          id: `flux-${result.seed || Date.now()}-${index}`,
          alt: query,
          preview: url ? `/api/image?url=${encodeURIComponent(url)}` : null,
          image: url,
          imageProxy: url ? `/api/image?url=${encodeURIComponent(url)}` : null,
          source: "flux",
        };
      })
      .filter((image) => image.preview && image.imageProxy);

    if (!images.length) {
      res.status(502).json({ error: "Flux returned no images." });
      return;
    }

    res.status(200).json({ images, source: "flux" });
  } catch (err) {
    res.status(500).json({ error: err.message || "Flux image generation failed." });
  }
}

function buildFluxPrompt(query, context = "") {
  const parts = [
    "Create a high-quality editorial news background image.",
    `Subject: ${query}.`,
  ];
  if (context) {
    parts.push(`Use these product-image recognition details as visual guidance: ${context}.`);
    parts.push("Respect any readable product text exactly if it appears, and preserve the identified pattern/motif style without inventing fake labels.");
  }
  parts.push(
    "Photorealistic, dramatic but natural lighting, sharp focus, premium newsroom/social poster style.",
    "Do not add unrelated text, captions, fake logos, or watermarks.",
  );
  return parts.join(" ");
}

async function runFalFlux(falKey, prompt) {
  const response = await fetch("https://fal.run/fal-ai/flux/schnell", {
    method: "POST",
    headers: {
      "Authorization": `Key ${falKey}`,
      "Content-Type": "application/json",
      "X-Fal-Store-IO": "0",
    },
    body: JSON.stringify({
      prompt,
      image_size: "portrait_16_9",
      num_images: 1,
      enable_safety_checker: true,
      output_format: "jpeg",
    }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = payload.detail || payload.error || `fal returned ${response.status}`;
    throw new Error(Array.isArray(detail) ? detail.map((item) => item.msg || item.message || String(item)).join("; ") : detail);
  }
  return payload;
}
