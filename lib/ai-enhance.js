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

export function imageExtensionPromptForAspect(value) {
  const target = POSTER_OUTPUTS[normalizePosterAspect(value)];
  return [
    `Outpaint this photograph into one seamless ${target.label} photograph filling the entire canvas.`,
    "The opaque mask protects the existing photograph. Generate only the transparent-mask margins around it, replacing the neutral grey placeholder there with a natural continuation of the scene.",
    "Keep the existing photograph in exactly the supplied position and scale. Do not zoom in, crop, move, duplicate or redraw it. The subject must stay smaller in the expanded view.",
    "Continue perspective, lighting, colours and depth of field naturally across every original edge. No picture-in-picture, rectangular frame, inset photo, blurred duplicate backdrop, mirrored edges, repeated subjects or ghost images.",
    "Preserve all existing faces, identities, expressions, skin and hair exactly. Do not enhance or invent pores, skin texture, beard hairs, sharpening halos or film grain. Keep soft source detail naturally soft.",
    "Extend only plausible background surroundings. Do not introduce additional people, objects, text, logos, captions or watermarks. Return a single continuous photograph, not a collage.",
  ].join("\n");
}

export function imageEnhancePrompt(imageKind = "photo") {
  return [
    "Restore this exact input image in place. Improve legibility and reduce compression artifacts without redesigning its content or composition.",
    "Keep the entire original image edge-to-edge, with the same aspect ratio, field of view, camera angle, layout, positions and relative sizes. Do not crop, zoom, reframe, outpaint, extend or generate new surroundings.",
    "Return the same single image, not a new composition. Do not create an inset, picture-in-picture, collage, rectangular panel, border, repeated scene, ghost image or enlarged duplicate background.",
    "If the input contains a map, diagram, screenshot, annotation or existing inset, preserve its exact layout. Do not reinterpret it as a photograph or turn it into a scene containing a picture of the input.",
    "Preserve existing text, labels, roads, borders, routes, symbols and geography in their original locations. Do not invent, duplicate, relocate, correct or add them. Leave unreadable details soft rather than guessing.",
    imageKind === "map" ? "This is a factual map or diagram. Its information and layout take priority over apparent sharpness. Apply only conservative cleanup; do not reconstruct terrain or redraw labels." : "Preserve the original image type and all factual details.",
    "Preserve each person's exact identity, facial geometry, expression, age, glasses, beard silhouette and skin tone.",
    "Preserve the original camera perspective, lighting, colours, depth of field and background.",
    "Perform gentle denoising and deblocking. Improve edge clarity only where the source visibly supports it.",
    "Do not invent or exaggerate pores, skin grain, wrinkles, beard hairs, fabric fibres, film grain, micro-contrast or sharpening halos.",
    "Keep blurry or low-information regions naturally soft instead of synthesizing texture.",
    "Do not beautify, airbrush, stylise, repaint or reconstruct the face. Avoid waxy, plastic, clay-like, gritty or illustrated skin.",
    "Do not add, remove or relocate people or objects. Do not add text, logos, captions, watermarks or graphics.",
    "Output only the restored input image, filling the output canvas. Fidelity is more important than extra detail.",
  ].join("\n");
}
