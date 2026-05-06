// Image proxy — fetches a remote image and pipes the bytes back with the
// original Content-Type. Lets the client load images that would otherwise
// trigger CORS errors (e.g. when drawing onto a canvas).

import { USER_AGENT } from "../lib/http.js";

export const config = {
  api: { responseLimit: "10mb" },
};

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed." });
    return;
  }

  try {
    const target = (req.query?.url || "").toString();
    if (!target) {
      res.status(400).json({ error: "Image URL is required." });
      return;
    }

    const parsed = new URL(target);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      res.status(400).json({ error: "Only http and https image URLs are supported." });
      return;
    }

    const r = await fetch(parsed, { headers: { "user-agent": USER_AGENT } });
    if (!r.ok) {
      res.status(502).json({ error: `Image source returned ${r.status}.` });
      return;
    }
    const contentType = r.headers.get("content-type") || "application/octet-stream";
    const buf = Buffer.from(await r.arrayBuffer());

    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.status(200).send(buf);
  } catch (err) {
    res.status(500).json({ error: err.message || "Image proxy failed." });
  }
}
