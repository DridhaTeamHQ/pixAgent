import { USER_AGENT, setCors, handlePreflight } from "../lib/http.js";

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  setCors(res);

  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed." });
    return;
  }

  const pexelsApiKey = process.env.PEXELS_API_KEY || "";
  if (!pexelsApiKey) {
    res.status(503).json({ error: "PEXELS_API_KEY not set on server." });
    return;
  }

  try {
    const query = (req.query?.query || "").toString().trim();
    if (!query) {
      res.status(400).json({ error: "A search query is required." });
      return;
    }

    const pexelsUrl = new URL("https://api.pexels.com/v1/search");
    pexelsUrl.searchParams.set("query", query);
    pexelsUrl.searchParams.set("per_page", "6");
    pexelsUrl.searchParams.set("orientation", "portrait");

    const r = await fetch(pexelsUrl, {
      headers: { Authorization: pexelsApiKey, "user-agent": USER_AGENT },
    });
    if (!r.ok) {
      res.status(502).json({ error: `Pexels returned ${r.status}.` });
      return;
    }
    const payload = await r.json();
    const images = (payload.photos || []).map((photo) => {
      const big = photo.src?.large2x || photo.src?.large || photo.src?.original;
      return {
        id: photo.id,
        alt: photo.alt || query,
        photographer: photo.photographer || "Pexels",
        pageUrl: photo.url,
        preview: photo.src?.medium || photo.src?.large || photo.src?.original,
        image: big,
        imageProxy: big ? `/api/image?url=${encodeURIComponent(big)}` : null,
      };
    }).filter((it) => it.preview && it.imageProxy);

    res.status(200).json({ images });
  } catch (err) {
    res.status(500).json({ error: err.message || "Image search failed." });
  }
}
