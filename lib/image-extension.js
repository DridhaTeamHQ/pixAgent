import { readRawBody } from "./http.js";
import { normalizeImageKind } from "./image-enhancement.js";
import {
  GPT_IMAGE_ENHANCE_MODEL, GPT_IMAGE_ENHANCE_QUALITY,
  imageEnhanceSizeForAspect, imageExtensionPromptForAspect, normalizePosterAspect,
} from "./ai-enhance.js";

const MAX_BODY_BYTES = 16 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function inputError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function readPNG(value, name) {
  if (typeof value !== "string" || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw inputError(`${name} must be a base64 PNG image.`);
  }
  const bytes = Buffer.from(value.slice("data:image/png;base64,".length), "base64");
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE) ||
      bytes.readUInt32BE(8) !== 13 || bytes.toString("ascii", 12, 16) !== "IHDR") {
    throw inputError(`${name} is not a valid PNG image.`);
  }
  return { bytes, width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), colorType: bytes[25] };
}

export function imageExtensionForm(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw inputError("Invalid extension request.");
  if (normalizeImageKind(payload.imageKind) === "map") {
    throw inputError("AI extension is disabled for maps and diagrams to avoid inventing factual content.");
  }
  const aspect = normalizePosterAspect(payload.aspect);
  if (payload.aspect !== aspect) throw inputError("Unsupported poster aspect.");
  const outputSize = imageEnhanceSizeForAspect(aspect);
  const [width, height] = outputSize.split("x").map(Number);
  const source = readPNG(payload.image, "Image");
  const mask = readPNG(payload.mask, "Mask");
  for (const png of [source, mask]) {
    if (png.width !== width || png.height !== height) {
      throw inputError(`Image and mask must both be ${outputSize}.`);
    }
  }
  if (![4, 6].includes(mask.colorType)) throw inputError("Mask must have an alpha channel.");
  const form = new FormData();
  form.append("model", GPT_IMAGE_ENHANCE_MODEL);
  form.append("quality", GPT_IMAGE_ENHANCE_QUALITY);
  form.append("size", outputSize);
  form.append("prompt", imageExtensionPromptForAspect(aspect));
  form.append("image", new Blob([source.bytes], { type: "image/png" }), "source.png");
  form.append("mask", new Blob([mask.bytes], { type: "image/png" }), "mask.png");
  return { form, aspect, outputSize };
}

// Shared by Railway and the serverless route: one direct GPT Image edit.
export async function extendImageRequest(req, apiKey) {
  if (!apiKey) return { status: 503, body: { error: "OPENAI_API_KEY not set on server." } };
  try {
    if (!String(req.headers["content-type"] || "").startsWith("application/json")) {
      throw inputError("Expected application/json.", 415);
    }
    if (Number(req.headers["content-length"]) > MAX_BODY_BYTES) throw inputError("Extension input exceeds 16 MB.", 413);
    let raw;
    try {
      raw = await readRawBody(req, MAX_BODY_BYTES);
    } catch (error) {
      if (error.message.startsWith("Body exceeds")) throw inputError("Extension input exceeds 16 MB.", 413);
      throw error;
    }
    let payload;
    try { payload = JSON.parse(raw.toString("utf8")); }
    catch { throw inputError("Invalid JSON request."); }
    const { form, aspect, outputSize } = imageExtensionForm(payload);
    const response = await fetch("https://api.openai.com/v1/images/edits", {
      method: "POST", headers: { Authorization: `Bearer ${apiKey}` }, body: form,
      signal: AbortSignal.timeout(240_000),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      return { status: 502, body: {
        error: String(data.error?.message || `OpenAI image ${response.status}`).slice(0, 300),
        upstreamStatus: response.status,
      } };
    }
    const b64 = data?.data?.[0]?.b64_json;
    if (!b64) return { status: 502, body: { error: "OpenAI returned no image data." } };
    return { status: 200, body: {
      image: `data:image/png;base64,${b64}`, engine: GPT_IMAGE_ENHANCE_MODEL,
      framing: "outpainted", aspect, outputSize,
    } };
  } catch (error) {
    return { status: error.status || 500, body: {
      error: error.status ? error.message : error.name === "TimeoutError"
        ? "Image extension timed out. Your original photo is unchanged."
        : "Image extension failed. Your original photo is unchanged.",
    } };
  }
}
