const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36";

// Strip CDN resize parameters to get original full-resolution images
function upgradeImageUrl(imageUrl) {
  try {
    const u = new URL(imageUrl);
    if (u.hostname.includes("cloudinary.com") || u.hostname.includes("res.cloudinary.com")) {
      u.pathname = u.pathname.replace(/\/c_\w+,[^/]+/g, "").replace(/\/w_\d+[^/]*/g, "").replace(/\/h_\d+[^/]*/g, "");
      return u.toString();
    }
    if (u.hostname.includes("imgix.net")) {
      u.searchParams.delete("w"); u.searchParams.delete("h");
      u.searchParams.delete("fit"); u.searchParams.delete("crop");
      u.searchParams.set("q", "100");
      return u.toString();
    }
    if (u.searchParams.has("resize") || u.searchParams.has("w") || u.searchParams.has("fit")) {
      u.searchParams.delete("resize"); u.searchParams.delete("w"); u.searchParams.delete("h");
      u.searchParams.delete("fit"); u.searchParams.delete("crop");
      return u.toString();
    }
    for (const key of ["width", "height", "w", "h", "quality", "q", "resize", "size", "maxwidth", "maxheight"]) {
      u.searchParams.delete(key);
    }
    if (u.hostname.includes("ytimg.com") && u.pathname.includes("hqdefault")) {
      return imageUrl.replace("hqdefault", "maxresdefault");
    }
    return u.toString();
  } catch { return imageUrl; }
}

function isLikelyHighQuality(url) {
  const lower = url.toLowerCase();
  if (lower.includes("favicon")) return false;
  if (lower.includes("/icon")) return false;
  if (lower.match(/\b(16|24|32|48|64|72|96)x\1\b/)) return false;
  if (lower.includes("thumbnail") && !lower.includes("maxresdefault")) return false;
  if (lower.includes("logo") && !lower.includes("article")) return false;
  return true;
}

export async function handler(event) {
  if (event.httpMethod !== "GET") {
    return { statusCode: 405, body: "Method not allowed" };
  }

  try {
    const params = event.queryStringParameters || {};
    const query = params.query?.trim();
    if (!query) {
      return json(400, { error: "A search query is required." });
    }

    let images = [];
    images = await tryBingImages(query, 8);
    if (!images.length) images = await tryGoogleImages(query, 8);
    if (!images.length) images = await tryDuckDuckGoImages(query, 8);

    return json(200, { images, source: images.length ? "web" : "none" });
  } catch (error) {
    return json(500, { error: error.message || "Image search failed." });
  }
}

async function tryBingImages(query, max) {
  try {
    // Try wallpaper size first (extra large)
    let results = await fetchBingSize(query, max, "wallpaper");
    // Fallback to large
    if (!results.length) results = await fetchBingSize(query, max, "large");
    return results;
  } catch { return []; }
}

async function fetchBingSize(query, max, size) {
  const bingUrl = `https://www.bing.com/images/search?q=${encodeURIComponent(query)}&qft=+filterui:imagesize-${size}+filterui:photo-photo&form=IRFLTR&first=1`;
  const response = await fetch(bingUrl, {
    headers: { "user-agent": USER_AGENT, "accept": "text/html,application/xhtml+xml", "accept-language": "en-US,en;q=0.9" }
  });
  if (!response.ok) return [];
  const html = await response.text();

  const results = [];
  const seen = new Set();
  const matches = html.matchAll(/"murl"\s*:\s*"(https?:[^"]+)"/gi);
  for (const m of matches) {
    if (results.length >= max) break;
    let url = m[1].replace(/\\u002f/gi, "/").replace(/\\u0026/gi, "&");
    if (url.includes("bing.com") || url.includes("bing.net") || url.includes("microsoft.com")) continue;
    if (!isLikelyHighQuality(url)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    const upgraded = upgradeImageUrl(url);
    results.push({
      id: results.length, alt: "Related Image",
      preview: `/api/image?url=${encodeURIComponent(upgraded)}`,
      image: upgraded,
      imageProxy: `/api/image?url=${encodeURIComponent(upgraded)}`,
      source: "bing"
    });
  }
  return results;
}

async function tryGoogleImages(query, max) {
  try {
    const googleUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}&tbm=isch&tbs=isz:l,itp:photo`;
    const response = await fetch(googleUrl, {
      headers: { "user-agent": USER_AGENT, "accept": "text/html,application/xhtml+xml", "accept-language": "en-US,en;q=0.9" }
    });
    if (!response.ok) return [];
    const html = await response.text();

    const results = [];
    const seen = new Set();
    const scriptMatches = html.matchAll(/\["(https?:\/\/[^"]+\.(?:jpg|jpeg|png|webp)[^"]*)",[0-9]+,[0-9]+\]/gi);
    for (const m of scriptMatches) {
      if (results.length >= max) break;
      let url = m[1].replace(/\\u003d/g, "=").replace(/\\u0026/g, "&").replace(/\\\/\//g, "//");
      if (url.includes("gstatic.com") || url.includes("google.com") || url.includes("googleapis.com")) continue;
      if (url.includes("x-raw-image")) continue;
      if (!isLikelyHighQuality(url)) continue;
      if (seen.has(url)) continue;
      seen.add(url);
      const upgraded = upgradeImageUrl(url);
      results.push({
        id: results.length, alt: "Google Image",
        preview: `/api/image?url=${encodeURIComponent(upgraded)}`,
        image: upgraded,
        imageProxy: `/api/image?url=${encodeURIComponent(upgraded)}`,
        source: "google"
      });
    }
    return results;
  } catch { return []; }
}

async function tryDuckDuckGoImages(query, max) {
  try {
    const tokenRes = await fetch(`https://duckduckgo.com/?q=${encodeURIComponent(query)}&iax=images&ia=images`, {
      headers: { "user-agent": USER_AGENT }
    });
    if (!tokenRes.ok) return [];
    const tokenHtml = await tokenRes.text();
    const vqd = tokenHtml.match(/vqd=([\d-]+)/)?.[1];
    if (!vqd) return [];

    const ddgUrl = `https://duckduckgo.com/i.js?l=us-en&o=json&q=${encodeURIComponent(query)}&vqd=${vqd}&f=type:photo,size:Large&p=1`;
    const res = await fetch(ddgUrl, {
      headers: { "user-agent": USER_AGENT, "accept": "application/json" }
    });
    if (!res.ok) return [];
    const data = await res.json();

    return (data.results || []).filter(r => isLikelyHighQuality(r.image || "")).slice(0, max).map((r, i) => {
      const upgraded = upgradeImageUrl(r.image);
      return {
        id: i, alt: r.title || "DuckDuckGo Image",
        preview: `/api/image?url=${encodeURIComponent(r.thumbnail || upgraded)}`,
        image: upgraded,
        imageProxy: `/api/image?url=${encodeURIComponent(upgraded)}`,
        source: "duckduckgo"
      };
    });
  } catch { return []; }
}

function json(statusCode, data) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" },
    body: JSON.stringify(data)
  };
}
