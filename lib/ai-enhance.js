export const GPT_IMAGE_ENHANCE_MODEL = "gpt-image-2";
export const GPT_IMAGE_ENHANCE_QUALITY = "high";

const POSTER_OUTPUTS = Object.freeze({
  "9:16": { size: "1008x1792", label: "vertical 9:16" },
  "4:5": { size: "1024x1280", label: "portrait 4:5" },
  "1:1": { size: "1024x1024", label: "square 1:1" },
  "16:9": { size: "1792x1008", label: "wide 16:9" },
});

export function normalizePosterAspect(value) {
  return Object.hasOwn(POSTER_OUTPUTS, value) ? value : "9:16";
}

export function imageEnhanceSizeForAspect(value) {
  return POSTER_OUTPUTS[normalizePosterAspect(value)].size;
}

export function imageEnhancePromptForAspect(value) {
  const aspect = normalizePosterAspect(value);
  const target = POSTER_OUTPUTS[aspect];

  return [
    `Conservatively restore this exact real news photograph for a ${target.label} editorial poster.`,
    "Reframe only with a natural crop and modest zoom. Keep the main face or subject in the upper-middle safe area and keep every face and head comfortably inside the frame.",
    "Keep important facial features out of the lower 30 percent, which will contain a headline overlay.",
    "Preserve each person's exact identity, facial geometry, expression, age, glasses, beard silhouette and skin tone.",
    "Preserve the original camera perspective, lighting, colours, depth of field and background.",
    "Perform gentle denoising and deblocking. Improve edge clarity only where the source visibly supports it.",
    "Do not invent or exaggerate pores, skin grain, wrinkles, beard hairs, fabric fibres, film grain, micro-contrast or sharpening halos.",
    "Keep blurry or low-information regions naturally soft instead of synthesizing texture.",
    "Do not beautify, airbrush, stylise, repaint or reconstruct the face. Avoid waxy, plastic, clay-like, gritty or illustrated skin.",
    "Do not add, remove or relocate people or objects. Do not add text, logos, captions, watermarks or graphics.",
    "Return a clean, natural documentary photograph, not AI artwork.",
  ].join("\n");
}
