import { GPT_IMAGE_ENHANCE_MODEL, GPT_IMAGE_ENHANCE_QUALITY, imageEnhancePrompt } from "./ai-enhance.js";

function invalid(message) {
  return Object.assign(new Error(message), { status: 400 });
}

export function normalizeImageKind(value) {
  if (value == null || value === "" || value === "photo") return "photo";
  if (value === "map") return "map";
  throw invalid("Unsupported image type.");
}

// Read dimensions from the actual upload, never from the poster aspect or
// client-supplied dimension headers. No image transformation or second model.
export function imageDimensions(bytes) {
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  let width, height, mime;
  if (bytes.length >= 33 && bytes.subarray(0, 8).equals(png) &&
      bytes.readUInt32BE(8) === 13 && bytes.toString("ascii", 12, 16) === "IHDR") {
    width = bytes.readUInt32BE(16);
    height = bytes.readUInt32BE(20);
    mime = "image/png";
  } else if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let position = 2;
    while (position < bytes.length) {
      if (bytes[position++] !== 0xff) break;
      while (bytes[position] === 0xff) position++;
      const marker = bytes[position++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (position + 2 > bytes.length) break;
      const length = bytes.readUInt16BE(position);
      if (length < 2 || position + length > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        if (length < 8) break;
        height = bytes.readUInt16BE(position + 3);
        width = bytes.readUInt16BE(position + 5);
        mime = "image/jpeg";
        break;
      }
      position += length;
    }
  }
  if (!width || !height) throw invalid("Unable to read image dimensions. Upload a PNG or JPEG image.");
  return { width, height, mime };
}

export function imageEnhanceSizeForSource(width, height) {
  const ratio = width / height;
  if (!Number.isFinite(ratio) || width <= 0 || height <= 0 || ratio < 1 / 3 || ratio > 3) {
    throw invalid("This image is too wide or tall for GPT Image enhancement without reframing. Crop it to an aspect ratio between 1:3 and 3:1 first.");
  }
  // GPT Image requires multiples of 16. Match source proportions as closely
  // as possible while staying near the previous ~1.8 MP quality/cost budget.
  let best;
  for (let w = 16; w <= 3840; w += 16) {
    const idealHeight = w / ratio / 16;
    for (const h of [Math.floor(idealHeight) * 16, Math.ceil(idealHeight) * 16]) {
      const area = w * h;
      if (h < 16 || h > 3840 || area < 655_360 || area > 2_097_152 || w / h < 1 / 3 || w / h > 3) continue;
      const score = Math.abs(Math.log((w / h) / ratio)) * 100 + Math.abs(Math.log(area / 1_800_000)) * 0.01;
      if (!best || score < best.score) best = { size: `${w}x${h}`, score };
    }
  }
  if (!best) throw invalid("Unsupported source dimensions.");
  return best.size;
}

export function imageEnhanceForm(bytes, kind) {
  const imageKind = normalizeImageKind(kind);
  const source = imageDimensions(bytes);
  const outputSize = imageEnhanceSizeForSource(source.width, source.height);
  const form = new FormData();
  form.append("model", GPT_IMAGE_ENHANCE_MODEL);
  form.append("quality", GPT_IMAGE_ENHANCE_QUALITY);
  form.append("size", outputSize);
  form.append("prompt", imageEnhancePrompt(imageKind));
  form.append("image", new Blob([bytes], { type: source.mime }), source.mime === "image/jpeg" ? "input.jpg" : "input.png");
  return { form, source, outputSize, imageKind };
}
