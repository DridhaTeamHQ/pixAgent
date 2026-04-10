const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36";

export async function handler(event) {
  // Only allow POST
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  try {
    const body = JSON.parse(event.body || "{}");
    const targetUrl = body?.url;

    if (!targetUrl) {
      return json(400, { error: "A URL is required." });
    }

    const parsedUrl = new URL(targetUrl);
    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
      return json(400, { error: "Only http and https URLs are supported." });
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);

    const headers = {
      "User-Agent": USER_AGENT,
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
      "Accept-Language": "en-US,en;q=0.9",
      "Cache-Control": "max-age=0",
      "Sec-Ch-Ua": '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
      "Sec-Ch-Ua-Mobile": "?0",
      "Sec-Ch-Ua-Platform": '"Windows"',
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "none",
      "Sec-Fetch-User": "?1",
      "Upgrade-Insecure-Requests": "1"
    };

    const response = await fetch(parsedUrl, { headers, signal: controller.signal }).finally(() => clearTimeout(timeoutId));
    if (!response.ok) {
      if (response.status === 403 || response.status === 401) {
         return json(422, { error: `This article is protected or behind a paywall (Error ${response.status}).` });
      }
      return json(502, { error: `News site refused connection (Status: ${response.status}).` });
    }

    const html = await response.text();

    // Extract title: og:title > twitter:title > <title> tag
    let title = extractMetaContent(html, ["og:title", "twitter:title"]);
    if (!title) {
      const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      title = titleMatch ? cleanupText(stripTags(titleMatch[1])) : "";
    }
    title = cleanupText(stripTags(title));
    title = title.replace(/\s*[-|–—]\s*[^-|–—]{2,30}$/i, "").trim();

    // Extract image
    // Prefer ultra-high-resolution JSON-LD image first, then fallback to opengraph metas
    let image = extractJsonLdImage(html) || extractMetaContent(html, ["og:image:secure_url", "og:image", "twitter:image", "twitter:image:src"]);
    if (image) {
      image = resolveMaybeRelative(image, targetUrl);
      image = upgradeImageToHighestQuality(image);
    }

    if (!title) {
      return json(422, { error: "Could not extract a title from this page." });
    }

    return json(200, {
      title: cleanupText(title),
      image: image || null,
      imageProxy: image ? `/api/image?url=${encodeURIComponent(image)}` : null,
      sourceUrl: targetUrl
    });
  } catch (error) {
    if (error.name === "AbortError") {
       return json(504, { error: "News site took too long to load (Timeout). It might be blocking scrapers." });
    }
    return json(500, { error: error.message || "Article scrape failed." });
  }
}

// --- Helpers ---

function json(statusCode, data) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" },
    body: JSON.stringify(data)
  };
}

function extractMetaContent(html, properties) {
  for (const prop of properties) {
    const regex = new RegExp(
      `<meta[^>]*(?:property|name)=["']${prop.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'][^>]*content=["']([^"']+)["']`,
      "i"
    );
    const match = html.match(regex);
    if (match?.[1]) return match[1];

    const regexReversed = new RegExp(
      `<meta[^>]*content=["']([^"']+)["'][^>]*(?:property|name)=["']${prop.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`,
      "i"
    );
    const matchR = html.match(regexReversed);
    if (matchR?.[1]) return matchR[1];
  }
  return null;
}

function resolveMaybeRelative(value, baseUrl) {
  try { return new URL(value.trim(), baseUrl).toString(); } catch { return null; }
}

function stripTags(value) {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ");
}

function cleanupText(value) {
  return decodeHtmlEntities(value).replace(/\s+/g, " ").trim();
}

function decodeHtmlEntities(value) {
  return value
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&hellip;/gi, "...");
}

function upgradeImageToHighestQuality(imageUrl) {
  try {
    const u = new URL(imageUrl);
    const host = u.hostname;

    // Strip WordPress hardcoded resize suffixes (e.g. image-768x432.jpg -> image.jpg)
    u.pathname = u.pathname.replace(/-\d+x\d+(\.(?:jpg|jpeg|png|webp|avif))$/i, "$1");

    if (host.includes("cloudinary.com")) {
      u.pathname = u.pathname.replace(/\/upload\/[^/]+\//, "/upload/q_auto:best,f_auto/");
      return u.toString();
    }
    if (host.includes("imgix.net") || u.searchParams.has("ixid")) {
      u.searchParams.delete("w"); u.searchParams.delete("h");
      u.searchParams.delete("fit"); u.searchParams.delete("crop");
      u.searchParams.delete("q"); u.searchParams.delete("auto");
      u.searchParams.set("q", "100");
      u.searchParams.set("auto", "format,compress");
      return u.toString();
    }
    if (u.searchParams.has("resize") || (u.searchParams.has("w") && !host.includes("twitter"))) {
      u.searchParams.delete("resize"); u.searchParams.delete("w");
      u.searchParams.delete("h"); u.searchParams.delete("fit");
      u.searchParams.delete("strip"); u.searchParams.delete("quality");
      return u.toString();
    }
    const toi = u.pathname.match(/^(.*?)\/thumb\/(\d+)x(\d+)(\/.*)?$/);
    if (toi) { u.pathname = toi[1] + (toi[4] || ""); return u.toString(); }
    if (host.includes("bbci.co.uk") || u.pathname.includes("/ichef/")) {
      u.pathname = u.pathname.replace(/\/\d+\//, "/1280/");
      return u.toString();
    }
    ["width", "height", "w", "h", "size", "quality", "q", "maxwidth", "maxheight", "scale"].forEach(p => u.searchParams.delete(p));
    return u.toString();
  } catch { return imageUrl; }
}

function extractJsonLdImage(html) {
  try {
    const regex = /<script type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
    let match;
    while ((match = regex.exec(html)) !== null) {
      const data = JSON.parse(match[1]);
      
      const checkNode = (node) => {
        if (!node) return null;
        if (node.image) {
          if (typeof node.image === 'string') return node.image;
          if (Array.isArray(node.image) && node.image.length > 0) {
            if (typeof node.image[0] === 'string') return node.image[0];
            if (node.image[0].url) return node.image[0].url;
          }
          if (node.image.url) return node.image.url;
        }
        return null;
      };

      if (Array.isArray(data)) {
        for (const item of data) {
          const img = checkNode(item);
          if (img) return img;
        }
      } else {
        const img = checkNode(data);
        if (img) return img;
        
        // Sometimes nested inside @graph
        if (data['@graph']) {
          for (const item of data['@graph']) {
            if (item['@type'] === 'ImageObject' && item.url) return item.url;
            if (item.image) {
              const nestedImg = checkNode(item);
              if (nestedImg) return nestedImg;
            }
          }
        }
      }
    }
  } catch(e) {}
  return null;
}
