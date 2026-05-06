import { USER_AGENT, setCors, handlePreflight } from "../lib/http.js";
import {
  extractMetaContent,
  stripTags,
  cleanupText,
  resolveMaybeRelative,
  upgradeImageToHighestQuality,
} from "../lib/scrape.js";

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  setCors(res);

  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed." });
    return;
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const targetUrl = body?.url;

    if (!targetUrl) {
      res.status(400).json({ error: "A URL is required." });
      return;
    }

    const parsedUrl = new URL(targetUrl);
    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
      res.status(400).json({ error: "Only http and https URLs are supported." });
      return;
    }

    const response = await fetch(parsedUrl, { headers: { "user-agent": USER_AGENT } });
    if (!response.ok) {
      res.status(502).json({ error: `Source returned ${response.status}.` });
      return;
    }
    const html = await response.text();

    // Title: og:title > twitter:title > <title> tag
    let title = extractMetaContent(html, ["og:title", "twitter:title"]);
    if (!title) {
      const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      title = titleMatch ? cleanupText(stripTags(titleMatch[1])) : "";
    }
    title = cleanupText(stripTags(title));
    title = title.replace(/\s*[-|–—]\s*[^-|–—]{2,30}$/i, "").trim();

    // Image: og:image:secure_url > og:image > twitter:image
    let image = extractMetaContent(html, ["og:image:secure_url", "og:image", "twitter:image", "twitter:image:src"]);
    if (image) {
      image = resolveMaybeRelative(image, targetUrl);
      image = upgradeImageToHighestQuality(image);
    }

    if (!title) {
      res.status(422).json({ error: "Could not extract a title from this page." });
      return;
    }

    res.status(200).json({
      title: cleanupText(title),
      image: image || null,
      imageProxy: image ? `/api/image?url=${encodeURIComponent(image)}` : null,
      sourceUrl: targetUrl,
    });
  } catch (err) {
    res.status(500).json({ error: err.message || "Article scrape failed." });
  }
}
