export async function handler(event) {
  if (event.httpMethod !== "GET") {
    return { statusCode: 405, body: "Method not allowed" };
  }

  try {
    const pexelsApiKey = process.env.PEXELS_API_KEY || "";
    if (!pexelsApiKey) {
      return json(500, { error: "Pexels API key is missing. Set PEXELS_API_KEY in Netlify environment variables." });
    }

    const params = event.queryStringParameters || {};
    const query = params.query?.trim();
    if (!query) {
      return json(400, { error: "A search query is required." });
    }

    const pexelsUrl = new URL("https://api.pexels.com/v1/search");
    pexelsUrl.searchParams.set("query", query);
    pexelsUrl.searchParams.set("per_page", "6");
    pexelsUrl.searchParams.set("orientation", "portrait");

    const response = await fetch(pexelsUrl, {
      headers: {
        Authorization: pexelsApiKey,
        "user-agent": "Mozilla/5.0"
      }
    });

    if (!response.ok) {
      return json(502, { error: `Pexels returned ${response.status}.` });
    }

    const payload = await response.json();
    const images = (payload.photos || []).map((photo) => {
      const bestSrc = photo.src?.large2x || photo.src?.large || photo.src?.original;
      return {
        id: photo.id,
        alt: photo.alt || query,
        photographer: photo.photographer || "Pexels",
        pageUrl: photo.url,
        preview: photo.src?.medium || photo.src?.large || photo.src?.original,
        image: bestSrc,
        imageProxy: bestSrc
          ? `/api/image?url=${encodeURIComponent(bestSrc.split('?')[0] + '?auto=compress&cs=tinysrgb&w=920&h=1700&fit=crop')}`
          : null
      };
    }).filter((item) => item.preview && item.imageProxy);

    return json(200, { images });
  } catch (error) {
    return json(500, { error: error.message || "Image search failed." });
  }
}

function json(statusCode, data) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" },
    body: JSON.stringify(data)
  };
}
