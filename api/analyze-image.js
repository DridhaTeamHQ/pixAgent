import { setCors, handlePreflight } from "../lib/http.js";

export const config = {
  api: { bodyParser: { sizeLimit: "8mb" } },
  maxDuration: 30,
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  setCors(res);

  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed." });
    return;
  }

  try {
    const apiKey = process.env.OPENAI_API_KEY || "";
    if (!apiKey) {
      res.status(503).json({ error: "OPENAI_API_KEY is missing." });
      return;
    }

    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const imageData = (body.imageData || "").trim();
    if (!imageData || !imageData.startsWith("data:image/")) {
      res.status(400).json({ error: "A base64 image data URL is required." });
      return;
    }

    const analysis = await analyzeImageWithOpenAI(apiKey, imageData);
    res.status(200).json({ analysis });
  } catch (err) {
    res.status(500).json({ error: err.message || "Image analysis failed." });
  }
}

async function analyzeImageWithOpenAI(apiKey, imageData) {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      input: [{
        role: "user",
        content: [
          {
            type: "input_text",
            text: [
              "Analyze this product image for a poster background generator.",
              "Use OCR/text recognition carefully. Also identify repeated patterns, product type, packaging shape, colors, materials, logos, labels, icons, and visible brand cues.",
              "Return only compact JSON with these keys:",
              "visibleText: exact text strings you can read,",
              "productType: short product category,",
              "brandCues: short array,",
              "patterns: short array of visual patterns or repeated motifs,",
              "colors: short array,",
              "promptHints: one concise sentence for image generation.",
              "If no text is readable, visibleText must be an empty array. Do not guess unreadable text.",
            ].join(" "),
          },
          { type: "input_image", image_url: imageData, detail: "high" },
        ],
      }],
      max_output_tokens: 500,
    }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = payload.error?.message || `OpenAI returned ${response.status}`;
    throw new Error(detail);
  }

  const text = extractOpenAIOutputText(payload).trim();
  try {
    return normalizeImageAnalysis(JSON.parse(text.replace(/^```json\s*|\s*```$/g, "")));
  } catch {
    return normalizeImageAnalysis({ promptHints: text });
  }
}

function extractOpenAIOutputText(payload) {
  if (payload.output_text) return payload.output_text;
  const chunks = [];
  for (const item of payload.output || []) {
    for (const content of item.content || []) {
      if (content.type === "output_text" && content.text) chunks.push(content.text);
    }
  }
  return chunks.join("\n");
}

function normalizeImageAnalysis(value) {
  const arrayOfStrings = (items) => Array.isArray(items)
    ? items.map((item) => String(item).trim()).filter(Boolean).slice(0, 8)
    : [];
  return {
    visibleText: arrayOfStrings(value.visibleText),
    productType: String(value.productType || "").trim().slice(0, 120),
    brandCues: arrayOfStrings(value.brandCues),
    patterns: arrayOfStrings(value.patterns),
    colors: arrayOfStrings(value.colors),
    promptHints: String(value.promptHints || "").trim().slice(0, 500),
  };
}
