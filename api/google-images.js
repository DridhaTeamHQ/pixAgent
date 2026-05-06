import { setCors, handlePreflight } from "../lib/http.js";
import { tryBingImages, tryGoogleImages, tryDuckDuckGoImages } from "../lib/image-search.js";

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  setCors(res);

  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed." });
    return;
  }

  try {
    const query = (req.query?.query || "").toString().trim();
    if (!query) {
      res.status(400).json({ error: "A search query is required." });
      return;
    }

    let images = await tryBingImages(query, 8);
    if (!images.length) images = await tryGoogleImages(query, 8);
    if (!images.length) images = await tryDuckDuckGoImages(query, 8);

    res.status(200).json({ images, source: images.length ? "web" : "none" });
  } catch (err) {
    res.status(500).json({ error: err.message || "Image search failed." });
  }
}
