import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import { imageEnhanceSizeForAspect } from "../lib/ai-enhance.js";

const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
// Exercise the actual classic-script renderer without booting the whole CMS.
function sourceOf(name) {
  const match = app.match(new RegExp(`^function ${name}\\([^]*?^}`, "m"));
  assert.ok(match, `${name} exists`);
  return match[0];
}
const names = ["clamp", "normalizeImageZoom", "getCoverImagePlacement", "drawCoverImage",
  "drawTextPreviewBackgroundImage", "getImageExtensionPlacement", "createImageExtensionInput",
  "imageEditSnapshot", "isCurrentImageEdit", "applyAIImageResult", "syncImageActionButtons"];
function runtime(extra = {}) {
  const draws = [];
  const context = vm.createContext({
    ctx: { save() {}, restore() {}, drawImage(...args) { draws.push(args); } },
    buildFilterString: () => "none", ...extra,
  });
  vm.runInContext(names.map(sourceOf).join("\n"), context);
  return { context, draws };
}

test("one full-cover image for all aspects, low legacy zooms, pan extremes and face focal points", () => {
  const { context, draws } = runtime();
  for (const [width, height] of [[920, 1700], [1080, 1350], [1080, 1080], [1920, 1080]]) {
    for (const [iw, ih] of [[1000, 1000], [2000, 500], [500, 2000], [1008, 1792]]) {
      for (const zoom of [0, 0.1, 0.3, 0.7, 1, 1.5, 3, NaN]) {
        for (const pan of [-900, 0, 900]) {
          const image = { width: iw, height: ih, __focalPoint: { x: iw * 0.8, y: ih * 0.1 } };
          draws.length = 0;
          context.drawCoverImage(image, 0, 0, width, height, { x: pan, y: -pan }, zoom);
          assert.equal(draws.length, 1, "no backdrop or duplicate source");
          const [, x, y, w, h] = draws[0];
          assert.ok(x <= 1e-6 && y <= 1e-6);
          assert.ok(x + w >= width - 1e-6 && y + h >= height - 1e-6, "covers every poster edge");
          assert.ok(Math.abs(w / h - iw / ih) < 1e-6, "source is never stretched");
        }
      }
    }
  }
});

test("zoom out reveals more source pixels until full coverage, then stops", () => {
  const { context } = runtime();
  const image = { width: 1000, height: 1000 };
  const rect = zoom => context.getCoverImagePlacement(image, 0, 0, 920, 1700, null, zoom);
  assert.ok(rect(2).width > rect(1).width);
  assert.deepEqual(rect(0.3), rect(1));
  assert.equal(rect(1).height, 1700);
  assert.equal(rect(1).x, -390);
});

test("text preview draws one blurred image with coverage, including export scale", () => {
  const { context, draws } = runtime();
  for (const zoom of [0.3, 0.7, 1, 3]) {
    for (const scale of [1, 4]) {
      draws.length = 0;
      context.drawTextPreviewBackgroundImage({ width: 1000, height: 1000 }, 0, 0, 920, 1700, { x: 900, y: -900 }, zoom, scale);
      assert.equal(draws.length, 1);
      const [, x, y, w, h] = draws[0];
      assert.ok(x <= 0 && y <= 0 && x + w >= 920 && y + h >= 1700);
    }
  }
});

test("extension fits the whole source and masks only that rectangle at every supported output size", () => {
  const canvases = [];
  const { context } = runtime({ document: { createElement() {
    const calls = [];
    const ctx = { fillRect(...args) { calls.push(["fill", ...args]); }, drawImage(...args) { calls.push(["draw", ...args]); } };
    const canvas = { calls, getContext: () => ctx, toDataURL: () => "data:image/png;base64,stub" };
    canvases.push(canvas);
    return canvas;
  } } });
  for (const aspect of ["9:16", "4:5", "1:1", "16:9"]) {
    for (const [width, height] of [[1000, 1000], [4000, 700], [500, 2000]]) {
      canvases.length = 0;
      const image = { width, height };
      context.createImageExtensionInput(image, aspect);
      const [source, mask] = canvases;
      assert.equal(`${source.width}x${source.height}`, imageEnhanceSizeForAspect(aspect));
      assert.equal(mask.width, source.width);
      assert.equal(mask.height, source.height);
      const draw = source.calls.find(call => call[0] === "draw");
      assert.equal(draw[1], image, "uses the raw photo, not the poster canvas");
      const [, , x, y, w, h] = draw;
      assert.ok(x > 0 && y > 0 && x + w < source.width && y + h < source.height);
      assert.ok(Math.abs(w / h - width / height) < 0.02);
      assert.deepEqual(mask.calls, [["fill", x, y, w, h]], "outside the source stays transparent");
      assert.equal(source.calls.filter(call => call[0] === "draw").length, 1);
    }
  }
});

test("AI result cannot replace a newer image, aspect or crop; successful result is undoable", () => {
  const original = { width: 1000, height: 1000 };
  const state = { mainImage: original, aspectRatio: "9:16", imageSelectionNonce: 1, imageZoom: 120, imageOffset: { x: 10, y: 20 } };
  let renders = 0;
  const { context } = runtime({ state, claimImageSelection() { state.imageSelectionNonce++; },
    resetImageControls() { state.imageZoom = 100; state.imageOffset = { x: 0, y: 0 }; },
    renderPoster() { renders++; } });
  const snapshot = context.imageEditSnapshot();
  for (const [key, value] of [["mainImage", {}], ["aspectRatio", "1:1"], ["imageSelectionNonce", 2], ["imageZoom", 150], ["imageOffset", { x: 15, y: 20 }]]) {
    const before = state[key];
    state[key] = value;
    assert.throws(() => context.applyAIImageResult({}, snapshot), /Result not applied/);
    state[key] = before;
  }
  const result = {};
  context.applyAIImageResult(result, snapshot);
  assert.equal(state.mainImage, result);
  assert.equal(state.imageEditUndo.image, original);
  assert.equal(state.imageEditUndo.zoom, 120);
  assert.equal(state.imageZoom, 100);
  assert.equal(renders, 1);
});

test("enhance and extension stay disabled throughout any AI request", () => {
  const state = { mainImage: {}, imageEditBusy: true };
  const elements = Object.fromEntries(["ai-enhance-btn", "ai-extend-btn", "ai-image-undo-btn"].map(id => [id, {}]));
  const { context } = runtime({ state, document: { getElementById: id => elements[id] } });
  context.syncImageActionButtons();
  assert.equal(elements["ai-enhance-btn"].disabled, true);
  assert.equal(elements["ai-extend-btn"].disabled, true);
  state.imageEditBusy = false;
  context.syncImageActionButtons();
  assert.equal(elements["ai-extend-btn"].disabled, false);
});

function imageActionRuntime(fetchImpl, enhancedDimensions = { width: 1500, height: 1500 }) {
  const original = { width: 1000, height: 1000 };
  const state = { mainImage: original, aspectRatio: "9:16", imageSelectionNonce: 1,
    imageZoom: 140, imageOffset: { x: 20, y: 30 }, imageEditBusy: false };
  const elements = {};
  const document = {
    getElementById(id) {
      return elements[id] ||= { handlers: {}, classList: { add() {}, remove() {} },
        addEventListener(type, fn) { this.handlers[type] = fn; } };
    },
    createElement() { return { getContext: () => ({ fillRect() {}, drawImage() {} }),
      toBlob: callback => callback(new Blob(["source"], { type: "image/png" })),
      toDataURL: () => "data:image/png;base64,fixture" }; },
  };
  const extended = { width: 1008, height: 1792 };
  const { context } = runtime({ state, document, fetch: fetchImpl,
    Image: class {
      constructor() { Object.assign(this, enhancedDimensions); }
      set src(value) { this.onload(); }
    },
    imgOffsetX: {}, imgOffsetY: {}, createImage: async () => extended,
    claimImageSelection() { state.imageSelectionNonce++; },
    resetImageControls() { state.imageZoom = 100; state.imageOffset = { x: 0, y: 0 }; },
    renderPoster() {},
  });
  const start = app.indexOf('const aiEnhanceBtn    =');
  const end = app.indexOf('/* ── Theme toggle', start);
  assert.ok(start > 0 && end > start);
  vm.runInContext(app.slice(start, end), context);
  return { state, elements, original, extended };
}

test("actual Extend and Undo click handlers preserve the source until success and restore its crop", async () => {
  let complete;
  let calls = 0;
  const pending = new Promise(resolve => { complete = resolve; });
  const { state, elements, original, extended } = imageActionRuntime(async (url, options) => {
    calls++;
    assert.equal(url, "/api/extend-image");
    assert.deepEqual(Object.keys(JSON.parse(options.body)).sort(), ["aspect", "image", "imageKind", "mask"]);
    return pending;
  });
  const job = elements["ai-extend-btn"].handlers.click();
  assert.equal(state.mainImage, original);
  assert.equal(state.imageEditBusy, true);
  assert.equal(elements["ai-enhance-btn"].disabled, true);
  await elements["ai-extend-btn"].handlers.click();
  assert.equal(calls, 1, "double-click cannot trigger another paid request");
  complete(Response.json({ image: "data:image/png;base64,result" }));
  await job;
  assert.equal(state.mainImage, extended);
  assert.equal(state.imageEditBusy, false);
  assert.equal(state.imageZoom, 100);
  elements["ai-image-undo-btn"].handlers.click();
  assert.equal(state.mainImage, original);
  assert.equal(state.imageZoom, 140);
  assert.equal(state.imageOffset.x, 20);
  assert.equal(state.imageOffset.y, 30);
  assert.equal(state.imageEditUndo, null);
});

test("actual Extend handler keeps the original on API failure and discards stale responses", async () => {
  const failed = imageActionRuntime(async () => Response.json({ error: "Bad mask" }, { status: 400 }));
  await failed.elements["ai-extend-btn"].handlers.click();
  assert.equal(failed.state.mainImage, failed.original);
  assert.equal(failed.state.imageEditBusy, false);
  assert.match(failed.elements["ai-extend-status"].textContent, /Bad mask/);
  let complete;
  const stale = imageActionRuntime(() => new Promise(resolve => { complete = resolve; }));
  const job = stale.elements["ai-extend-btn"].handlers.click();
  const newerImage = {};
  stale.state.mainImage = newerImage;
  stale.state.imageSelectionNonce++;
  complete(Response.json({ image: "data:image/png;base64,result" }));
  await job;
  assert.equal(stale.state.mainImage, newerImage);
  assert.equal(stale.state.imageEditBusy, false);
  assert.match(stale.elements["ai-extend-status"].textContent, /Result not applied/);
});

test("enhancement keeps the same crop and normalized focal point", () => {
  const original = { width: 1200, height: 800, __focalPoint: { x: 900, y: 300 } };
  const state = { mainImage: original, aspectRatio: "9:16", imageSelectionNonce: 1, imageZoom: 140, imageOffset: { x: 20, y: 30 } };
  const { context } = runtime({ state, claimImageSelection() { state.imageSelectionNonce++; },
    resetImageControls() { throw Error("must not reset crop on enhance"); }, renderPoster() {} });
  const snapshot = context.imageEditSnapshot();
  const result = { width: 1800, height: 1200 };
  context.applyAIImageResult(result, snapshot, true);
  assert.equal(state.mainImage, result);
  assert.equal(state.imageZoom, 140); assert.equal(state.imageOffset.x, 20); assert.equal(state.imageOffset.y, 30);
  assert.equal(result.__focalPoint.x / result.width, 0.75);
  assert.equal(result.__focalPoint.y / result.height, 0.375);
});

test("enhancement rejects a portrait result for a landscape source without replacing it", () => {
  const state = { mainImage: { width: 1200, height: 800 }, aspectRatio: "9:16", imageSelectionNonce: 1,
    imageZoom: 100, imageOffset: { x: 0, y: 0 } };
  const { context } = runtime({ state });
  const snapshot = context.imageEditSnapshot();
  assert.throws(() => context.applyAIImageResult({ width: 1008, height: 1792 }, snapshot, true), /changed the image proportions/);
  assert.equal(state.mainImage, snapshot.image);
});

test("map mode blocks extension in button state and actual click handler", async () => {
  let calls = 0;
  const { state, elements } = imageActionRuntime(async () => { calls++; });
  elements["image-is-map"].handlers.change({ target: { checked: true } });
  assert.equal(state.imageKind, "map");
  assert.equal(elements["ai-extend-btn"].disabled, true);
  assert.equal(elements["ai-enhance-btn"].disabled, false);
  await elements["ai-extend-btn"].handlers.click();
  assert.equal(calls, 0);
  elements["image-is-map"].handlers.change({ target: { checked: false } });
  assert.equal(elements["ai-extend-btn"].disabled, false);
});

test("actual Enhance handler sends source type, not poster aspect, and retains crop", async () => {
  let captured;
  const { state, elements, original } = imageActionRuntime(async (url, options) => {
    captured = { url, options };
    return Response.json({ image: "data:image/png;base64,result", framing: "source-preserved" });
  });
  elements["image-is-map"].handlers.change({ target: { checked: true } });
  await elements["ai-enhance-btn"].handlers.click();
  assert.equal(captured.url, "/api/upscale-image");
  assert.equal(captured.options.headers["X-Image-Kind"], "map");
  assert.equal(captured.options.headers["X-Poster-Aspect"], undefined);
  assert.notEqual(state.mainImage, original);
  assert.equal(state.imageZoom, 140);
  assert.equal(state.imageOffset.x, 20);
  assert.equal(state.imageEditBusy, false);
  assert.equal(state.imageEditUndo.image, original);
  assert.match(elements["ai-enhance-status"].textContent, /crop is unchanged/);
});

test("actual Enhance handler rejects old-server replies and changed proportions", async () => {
  for (const [framing, dimensions, expected] of [
    ["poster-aware", { width: 1500, height: 1500 }, /old reframing enhancement/],
    ["source-preserved", { width: 1008, height: 1792 }, /changed the image proportions/],
  ]) {
    const { state, elements, original } = imageActionRuntime(async () => Response.json({
      image: "data:image/png;base64,result", framing,
    }), dimensions);
    await elements["ai-enhance-btn"].handlers.click();
    assert.equal(state.mainImage, original);
    assert.equal(state.imageEditBusy, false);
    assert.match(elements["ai-enhance-status"].textContent, expected);
  }
});
