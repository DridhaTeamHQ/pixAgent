import assert from "node:assert/strict";
import test from "node:test";
import { deflateSync } from "node:zlib";
import { extendImageRequest, imageExtensionForm } from "../lib/image-extension.js";
import handler from "../api/extend-image.js";

// Valid RGBA PNG fixtures, without an image-processing dependency.
function png(width, height) {
  function chunk(type, data) {
    const body = Buffer.concat([Buffer.from(type), data]);
    let crc = 0xffffffff;
    for (const byte of body) {
      crc ^= byte;
      for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    const output = Buffer.alloc(data.length + 12);
    output.writeUInt32BE(data.length);
    body.copy(output, 4);
    output.writeUInt32BE((crc ^ 0xffffffff) >>> 0, output.length - 4);
    return output;
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const pixels = Buffer.alloc((width * 4 + 1) * height);
  const bytes = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk("IHDR", header), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]);
  return `data:image/png;base64,${bytes.toString("base64")}`;
}
const source = png(1008, 1792);
const payload = { image: source, mask: source, aspect: "9:16" };
function request(body = payload, headers = {}) {
  return { method: "POST", headers: { "content-type": "application/json", ...headers },
    async *[Symbol.asyncIterator]() { yield Buffer.from(typeof body === "string" ? body : JSON.stringify(body)); } };
}

test("extension sends image plus alpha mask to one direct GPT Image edit", async t => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls++;
    assert.equal(url, "https://api.openai.com/v1/images/edits");
    assert.equal(options.body.get("model"), "gpt-image-2");
    assert.equal(options.body.get("size"), "1008x1792");
    assert.equal(options.body.get("quality"), "high");
    assert.equal(options.body.has("input_fidelity"), false);
    assert.ok(options.body.get("image") instanceof Blob);
    assert.ok(options.body.get("mask") instanceof Blob);
    assert.match(options.body.get("prompt"), /Generate only the transparent-mask margins/);
    assert.match(options.body.get("prompt"), /No picture-in-picture/);
    return Response.json({ data: [{ b64_json: "result" }] });
  });
  const result = await extendImageRequest(request(), "test-key");
  assert.equal(calls, 1);
  assert.equal(result.status, 200);
  assert.equal(result.body.framing, "outpainted");
});

test("reject malformed or mismatched input before spending credits", async t => {
  t.mock.method(globalThis, "fetch", () => { throw new Error("must not call upstream"); });
  for (const body of ["not-json", null, {}, { ...payload, imageKind: "map" }, { ...payload, imageKind: "invalid" }, { ...payload, aspect: "bad" }, { ...payload, mask: "bad" }, { ...payload, mask: png(1024, 1024) }]) {
    assert.equal((await extendImageRequest(request(body), "test-key")).status, 400);
  }
  assert.equal((await extendImageRequest(request(), "")).status, 503);
  assert.equal((await extendImageRequest(request(payload, { "content-type": "image/png" }), "test-key")).status, 415);
  assert.equal((await extendImageRequest(request(payload, { "content-length": 17 * 1024 * 1024 }), "test-key")).status, 413);
  assert.equal(globalThis.fetch.mock.callCount(), 0);
});

test("all supported output sizes accept a matching mask", () => {
  for (const [aspect, w, h] of [["9:16",1008,1792], ["4:5",1024,1280], ["1:1",1024,1024], ["16:9",1792,1008]]) {
    const image = png(w,h);
    assert.equal(imageExtensionForm({ image, mask: image, aspect }).outputSize, `${w}x${h}`);
  }
});

test("upstream errors and empty results are failures, not fake successful images", async t => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ error: { message: "Invalid mask" } }, { status: 400 }));
  let result = await extendImageRequest(request(), "test-key");
  assert.equal(result.status, 502);
  assert.equal(result.body.error, "Invalid mask");
  assert.equal(result.body.image, undefined);
  globalThis.fetch.mock.mockImplementation(async () => Response.json({ data: [] }));
  result = await extendImageRequest(request(), "test-key");
  assert.equal(result.status, 502);
  assert.equal(result.body.image, undefined);
});

test("serverless extension route rejects unsupported methods", async () => {
  let status;
  await handler({ method: "GET" }, { status(code) { status = code; return this; }, json() {} });
  assert.equal(status, 405);
});
