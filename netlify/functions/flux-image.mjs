const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36";

export async function handler(event) {
  if (event.httpMethod !== "GET") {
    return json(405, { error: "Method not allowed." });
  }

  try {
    const falKey = process.env.FAL_KEY || "";
    if (!falKey) {
      return json(503, { error: "FAL_KEY is missing." });
    }

    const query = (event.queryStringParameters?.query || "").trim();
    const context = (event.queryStringParameters?.context || "").trim();
    if (!query) {
      return json(400, { error: "A prompt is required." });
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
      return json(502, { error: "Flux returned no images." });
    }

    return json(200, { images, source: "flux" });
  } catch (error) {
    return json(500, { error: error.message || "Flux image generation failed." });
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
      "user-agent": USER_AGENT,
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

function json(statusCode, payload) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
    body: JSON.stringify(payload),
  };
}
