import assert from "node:assert/strict";
import test from "node:test";

import handler from "../api/upscale-image.js";

test("AI Enhance sends GPT Image 1.5 with automatic framing and detail", async () => {
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
  const req = {
    method: "POST",
    headers: { "content-type": "image/png" },
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
  assert.equal(form.get("model"), "gpt-image-1.5");
  assert.equal(form.get("size"), "auto");
  assert.equal(form.get("quality"), "auto");
  assert.equal(form.has("input_fidelity"), false);
  assert.ok(form.get("image") instanceof Blob);

  assert.equal(responseBody.engine, "gpt-image-1.5");
  assert.equal(responseBody.framing, "auto");
  assert.equal(responseBody.detail, "auto");
});
