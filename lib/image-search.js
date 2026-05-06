// Multi-source web image search (Bing → Google → DuckDuckGo).
// Used by /api/google-images.

import { USER_AGENT } from "./http.js";

// Strip CDN resize parameters to get original full-resolution images.
export function upgradeImageUrl(imageUrl) {
  try {
    const u = new URL(imageUrl);
    if (u.hostname.includes("cloudinary.com") || u.hostname.includes("res.cloudinary.com")) {
      u.pathname = u.pathname
        .replace(/\/c_\w+,[^/]+/g, "")
        .replace(/\/w_\d+[^/]*/g, "")
        .replace(/\/h_\d+[^/]*/g, "");
      return u.toString();
    }
    if (u.hostname.includes("imgix.net")) {
      ["w","h","fit","crop"].forEach(p => u.searchParams.delete(p));
      u.searchParams.set("q", "100");
      return u.toString();
    }
    if (u.searchParams.has("resize") || u.searchParams.has("w") || u.searchParams.has("fit")) {
      ["resize","w","h","fit","crop"].forEach(p => u.searchParams.delete(p));
      return u.toString();
    }
    ["width","height","w","h","quality","q","resize","size","maxwidth","maxheight"]
      .forEach(k => u.searchParams.delete(k));
    if (u.hostname.includes("ytimg.com") && u.pathname.includes("hqdefault")) {
      return imageUrl.replace("hqdefault", "maxresdefault");
    }
    return u.toString();
  } catch { return imageUrl; }
}

export function isLikelyHighQuality(url) {
  const lower = (url || "").toLowerCase();
  if (lower.includes("favicon")) return false;
  if (lower.includes("/icon")) return false;
  if (lower.match(/\b(16|24|32|48|64|72|96)x\1\b/)) return false;
  if (lower.includes("thumbnail") && !lower.includes("maxresdefault")) return false;
  if (lower.includes("logo") && !lower.includes("article")) return false;
  return true;
}

const IMG_HEADERS = {
  "user-agent": USER_AGENT,
  "accept": "text/html,application/xhtml+xml",
  "accept-language": "en-US,en;q=0.9",
};

function makeResult(url, source, idx, alt) {
  const upgraded = upgradeImageUrl(url);
  return {
    id: idx,
    alt: alt || `${source} image`,
    preview: `/api/image?url=${encodeURIComponent(upgraded)}`,
    image: upgraded,
    imageProxy: `/api/image?url=${encodeURIComponent(upgraded)}`,
    source,
  };
}

async function bingSearch(query, max, sizeFilter) {
  const url = `https://www.bing.com/images/search?q=${encodeURIComponent(query)}&qft=+filterui:imagesize-${sizeFilter}&form=IRFLTR&first=1`;
  const r = await fetch(url, { headers: IMG_HEADERS });
  if (!r.ok) return [];
  const html = await r.text();
  const out = [];
  const seen = new Set();
  for (const m of html.matchAll(/"murl"\s*:\s*"(https?:[^"]+)"/gi)) {
    if (out.length >= max) break;
    const u = m[1].replace(/\\u002f/gi, "/").replace(/\\u0026/gi, "&");
    if (/\b(bing|microsoft)\.(com|net)\b/.test(u)) continue;
    if (!isLikelyHighQuality(u) || seen.has(u)) continue;
    seen.add(u);
    out.push(makeResult(u, "bing", out.length));
  }
  return out;
}

export async function tryBingImages(query, max) {
  try {
    const results = await bingSearch(query, max, "wallpaper");
    if (results.length) return results;
    return await bingSearch(query, max, "large");
  } catch { return []; }
}

export async function tryGoogleImages(query, max) {
  try {
    const url = `https://www.google.com/search?q=${encodeURIComponent(query)}&tbm=isch&tbs=isz:lt,islt:2mp`;
    const r = await fetch(url, { headers: IMG_HEADERS });
    if (!r.ok) return [];
    const html = await r.text();
    const out = []; const seen = new Set();
    for (const m of html.matchAll(/\["(https?:\/\/[^"]+\.(?:jpg|jpeg|png|webp)[^"]*)",[0-9]+,[0-9]+\]/gi)) {
      if (out.length >= max) break;
      let u = m[1].replace(/\\u003d/g,"=").replace(/\\u0026/g,"&").replace(/\\\/\//g,"//");
      if (/(gstatic|google|googleapis)\.com/.test(u) || u.includes("x-raw-image")) continue;
      if (!isLikelyHighQuality(u) || seen.has(u)) continue;
      seen.add(u);
      out.push(makeResult(u, "google", out.length, "Google image"));
    }
    return out;
  } catch { return []; }
}

export async function tryDuckDuckGoImages(query, max) {
  try {
    const tokenRes = await fetch(
      `https://duckduckgo.com/?q=${encodeURIComponent(query)}&iax=images&ia=images`,
      { headers: { "user-agent": USER_AGENT } }
    );
    if (!tokenRes.ok) return [];
    const vqd = (await tokenRes.text()).match(/vqd=([\d-]+)/)?.[1];
    if (!vqd) return [];

    const ddgUrl = `https://duckduckgo.com/i.js?l=us-en&o=json&q=${encodeURIComponent(query)}&vqd=${vqd}&f=size:Large&p=1`;
    const r = await fetch(ddgUrl, { headers: { "user-agent": USER_AGENT, accept: "application/json" } });
    if (!r.ok) return [];
    const data = await r.json();
    return (data.results || [])
      .filter(it => isLikelyHighQuality(it.image || ""))
      .slice(0, max)
      .map((it, i) => {
        const upgraded = upgradeImageUrl(it.image);
        return {
          id: i,
          alt: it.title || "DuckDuckGo Image",
          preview: `/api/image?url=${encodeURIComponent(it.thumbnail || upgraded)}`,
          image: upgraded,
          imageProxy: `/api/image?url=${encodeURIComponent(upgraded)}`,
          source: "duckduckgo",
        };
      });
  } catch { return []; }
}
