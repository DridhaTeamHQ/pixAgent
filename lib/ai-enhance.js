export const GPT_IMAGE_ENHANCE_MODEL = "gpt-image-1.5";
export const GPT_IMAGE_ENHANCE_SIZE = "auto";
export const GPT_IMAGE_ENHANCE_QUALITY = "auto";

export const IMAGE_ENHANCE_PROMPT = [
  "Upscale and restore this exact real news photograph.",
  "Choose the most appropriate editorial framing automatically from the source image.",
  "Keep every face, head, hand, main subject and important context comfortably inside the frame; do not crop them accidentally.",
  "Preserve the original camera perspective, lighting, colours and background.",
  "Preserve every person's exact identity, facial geometry, expression, age, pores, wrinkles, facial hair and natural skin texture.",
  "Recover an appropriate amount of realistic photographic detail automatically, using restrained sharpening.",
  "Remove only compression artifacts and sensor noise.",
  "Do not smooth, airbrush, beautify, stylise, repaint or reconstruct skin. Avoid waxy, plastic, clay-like or illustrated faces.",
  "Do not add, remove or move people or objects. Do not add text, logos, captions, watermarks or graphics.",
  "Return a natural documentary photograph, not AI artwork.",
].join("\n");
