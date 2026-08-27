import assert from "node:assert/strict";
import test from "node:test";

import handler from "../api/upscale-image.js";
import {
  imageEnhanceSizeForAspect,
  normalizePosterAspect,
} from "../lib/ai-enhance.js";
import { imageEnhanceSizeForSource } from "../lib/image-enhancement.js";

test("poster aspects map to exact GPT Image 2 canvases", () => {
  assert.equal(imageEnhanceSizeForAspect("9:16"), "1008x1792");
  assert.equal(imageEnhanceSizeForAspect("4:5"), "1024x1280");
  assert.equal(imageEnhanceSizeForAspect("1:1"), "1024x1024");
  assert.equal(imageEnhanceSizeForAspect("16:9"), "1792x1008");
  assert.equal(normalizePosterAspect("unexpected"), "9:16");
});

test("AI Enhance ignores the poster aspect and requests source-preserving restoration", async () => {
  const previousKey = process.env.OPENAI_API_KEY;
  const previousFetch = globalThis.fetch;
  process.env.OPENAI_API_KEY = "test-key-not-a-real-secret";

  let capturedRequest;
  globalThis.fetch = async (url, options) => {
    capturedRequest = { url, options };
    return new Response(JSON.stringify({ data: [{ b64_json: "dGVzdA==" }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  const source = Buffer.alloc(1200, 1);
  Buffer.from([137,80,78,71,13,10,26,10]).copy(source);
  source.writeUInt32BE(13, 8); source.write("IHDR", 12);
  source.writeUInt32BE(1200, 16); source.writeUInt32BE(800, 20);
  const req = {
    method: "POST",
    headers: { "content-type": "image/png", "x-poster-aspect": "9:16" },
    async *[Symbol.asyncIterator]() {
      yield source;
    },
  };

  let statusCode;
  let responseBody;
  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(body) {
      responseBody = body;
      return this;
    },
  };

  try {
    await handler(req, res);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
  }

  assert.equal(statusCode, 200);
  assert.equal(capturedRequest.url, "https://api.openai.com/v1/images/edits");
  assert.equal(capturedRequest.options.method, "POST");

  const form = capturedRequest.options.body;
  assert.equal(form.get("model"), "gpt-image-2");
  assert.equal(form.get("size"), imageEnhanceSizeForSource(1200, 800));
  assert.equal(form.get("quality"), "high");
  assert.equal(form.has("input_fidelity"), false);
  assert.ok(form.get("image") instanceof Blob);
  assert.match(form.get("prompt"), /Do not invent or exaggerate pores/);
  assert.match(form.get("prompt"), /Do not crop, zoom, reframe, outpaint, extend/);
  assert.doesNotMatch(form.get("prompt"), /lower 30 percent|editorial poster/);

  assert.equal(responseBody.engine, "gpt-image-2");
  assert.equal(responseBody.framing, "source-preserved");
  assert.equal(responseBody.aspect, undefined);
  assert.equal(responseBody.sourceWidth, 1200);
  assert.equal(responseBody.sourceHeight, 800);
  assert.equal(responseBody.outputSize, imageEnhanceSizeForSource(1200, 800));
  assert.equal(responseBody.detail, "high");
});
