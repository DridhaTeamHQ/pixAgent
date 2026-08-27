import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import handler from "../api/upscale-image.js";
import { GPT_IMAGE_ENHANCE_MODEL, GPT_IMAGE_ENHANCE_QUALITY, imageEnhanceSizeForAspect, imageEnhancePrompt } from "../lib/ai-enhance.js";
import { imageDimensions, imageEnhanceForm, imageEnhanceSizeForSource } from "../lib/image-enhancement.js";
import { deflateSync } from "node:zlib";

function png(width, height) {
  function chunk(type, data) {
    const body = Buffer.concat([Buffer.from(type), data]);
    let crc = 0xffffffff;
    for (const byte of body) {
      crc ^= byte;
      for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    const output = Buffer.alloc(data.length + 12);
    output.writeUInt32BE(data.length); body.copy(output, 4);
    output.writeUInt32BE((crc ^ 0xffffffff) >>> 0, output.length - 4);
    return output;
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.alloc((width * 4 + 1) * height))), chunk("IEND", Buffer.alloc(0))]);
}
const source = png(1200, 800);

test("enhancement respects source proportions and API size constraints, not the poster", () => {
  for (const [width, height] of [[1200,800], [800,1200], [1920,1080], [1080,1920], [1000,1000], [1000,667], [3000,1000], [1000,3000], [4156,7680]]) {
    const [w,h] = imageEnhanceSizeForSource(width, height).split("x").map(Number);
    assert.equal(w % 16, 0); assert.equal(h % 16, 0);
    assert.ok(Math.abs((w/h)/(width/height) - 1) < 0.01);
    assert.ok(w/h >= 1/3 && w/h <= 3);
    assert.ok(w*h >= 655_360 && w*h <= 2_097_152);
    assert.ok(w <= 3840 && h <= 3840);
  }
  assert.notEqual(imageEnhanceSizeForSource(1200, 800), imageEnhanceSizeForAspect("9:16"));
  for (const [w,h] of [[4000,1000], [1000,4000], [0,0], [NaN,800]]) {
    assert.throws(() => imageEnhanceSizeForSource(w,h), /without reframing/);
  }
});

test("source dimensions are read from PNG and JPEG headers; bad uploads are rejected", () => {
  assert.deepEqual(imageDimensions(source), { width: 1200, height: 800, mime: "image/png" });
  // Minimal SOF segment for dimension parsing, not a pixel-decoding fixture.
  const jpeg = Buffer.from([0xff,0xd8,0xff,0xc0,0,11,8,3,32,4,176,1,1,0x11,0,0xff,0xd9]);
  assert.deepEqual(imageDimensions(jpeg), { width: 1200, height: 800, mime: "image/jpeg" });
  for (const bytes of [Buffer.alloc(1200), source.subarray(0,25), jpeg.subarray(0,7), png(0,100)]) {
    assert.throws(() => imageDimensions(bytes), /Unable to read/);
  }
});

test("restoration prompt forbids new composition and preserves factual maps", () => {
  const prompt = imageEnhancePrompt("map");
  assert.match(prompt, /Do not crop, zoom, reframe, outpaint, extend/);
  assert.match(prompt, /picture-in-picture/);
  assert.match(prompt, /Preserve existing text, labels, roads/);
  assert.match(prompt, /This is a factual map or diagram/);
  assert.match(prompt, /Do not invent or exaggerate pores/);
  assert.doesNotMatch(prompt, /editorial poster|lower 30 percent|upper-middle|modest zoom/);
});

const serverSource = readFileSync(new URL("../server.mjs", import.meta.url), "utf8");
const railwayCode = serverSource.match(/^async function handleUpscaleImage\([^]*?^}/m)?.[0];
assert.ok(railwayCode);

for (const route of ["serverless", "Railway"]) {
  test(`${route}: a landscape map stays landscape even with a legacy portrait header`, async t => {
    let captured;
    const fetchMock = async (url, options) => {
      captured = { url, options };
      return Response.json({ data: [{ b64_json: "dGVzdA==" }] });
    };
    t.mock.method(globalThis, "fetch", fetchMock);
    const previousKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "test-key";
    t.after(() => { if (previousKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previousKey; });
    const req = { method: "POST", headers: { "content-type": "image/png", "x-poster-aspect": "9:16", "x-image-kind": "map" },
      async *[Symbol.asyncIterator]() { yield source; } };
    let status, result;
    const res = { status(code) { status = code; return this; }, json(data) { result = data; } };
    if (route === "serverless") await handler(req, res);
    else {
      const context = vm.createContext({ Buffer, imageEnhanceForm, GPT_IMAGE_ENHANCE_MODEL, GPT_IMAGE_ENHANCE_QUALITY,
        openaiApiKey: "test-key", fetch: fetchMock, console: { log() {}, error() {} },
        sendJson(_res, code, data) { status = code; result = data; } });
      vm.runInContext(railwayCode, context);
      await context.handleUpscaleImage(req, res);
    }
    assert.equal(status, 200);
    assert.equal(captured.url, "https://api.openai.com/v1/images/edits");
    const form = captured.options.body;
    assert.equal(form.get("model"), "gpt-image-2");
    assert.equal(form.get("quality"), "high");
    assert.equal(form.get("size"), imageEnhanceSizeForSource(1200,800));
    assert.equal(form.has("input_fidelity"), false);
    assert.equal(form.has("mask"), false, "enhancement does not outpaint");
    assert.match(form.get("prompt"), /factual map/);
    assert.equal(result.framing, "source-preserved");
    assert.equal(result.sourceWidth, 1200); assert.equal(result.sourceHeight, 800);
    assert.equal(result.aspect, undefined, "poster ratio is not part of enhancement");
  });
}

test("invalid source and unsupported image kind fail before an OpenAI request", async t => {
  t.mock.method(globalThis, "fetch", () => { throw Error("must not call"); });
  assert.throws(() => imageEnhanceForm(Buffer.alloc(1200)), /Unable to read/);
  assert.throws(() => imageEnhanceForm(source, "unknown"), /Unsupported image type/);
  assert.throws(() => imageEnhanceForm(png(400,100)), /without reframing/);
  assert.equal(globalThis.fetch.mock.callCount(), 0);
});
