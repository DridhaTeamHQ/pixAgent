// HTML scraping helpers — used by api/scrape-article.js.
// Pure string/regex utilities, no Node-specific I/O.

export function extractMetaContent(html, names) {
  for (const name of names) {
    const propertyRegex = new RegExp(
      `<meta[^>]+(?:property|name)=["']${escapeForRegex(name)}["'][^>]+content=["']([^"']+)["'][^>]*>`,
      "i"
    );
    const contentFirstRegex = new RegExp(
      `<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${escapeForRegex(name)}["'][^>]*>`,
      "i"
    );
    const match = html.match(propertyRegex) || html.match(contentFirstRegex);
    if (match?.[1]) return decodeHtmlEntities(match[1]);
  }
  return null;
}

export function stripTags(value) {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ");
}

export function cleanupText(value) {
  return decodeHtmlEntities(value).replace(/\s+/g, " ").trim();
}

export function decodeHtmlEntities(value) {
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

export function resolveMaybeRelative(value, baseUrl) {
  try { return new URL(value.trim(), baseUrl).toString(); }
  catch { return null; }
}

export function escapeForRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Strip CDN size params to upgrade an image URL to its highest available quality.
export function upgradeImageToHighestQuality(imageUrl) {
  try {
    const u = new URL(imageUrl);
    const host = u.hostname;

    if (host.includes("cloudinary.com")) {
      u.pathname = u.pathname.replace(/\/upload\/[^/]+\//, "/upload/q_auto:best,f_auto/");
      return u.toString();
    }
    if (host.includes("imgix.net") || u.searchParams.has("ixid")) {
      ["w", "h", "fit", "crop", "q", "auto"].forEach(p => u.searchParams.delete(p));
      u.searchParams.set("q", "100");
      u.searchParams.set("auto", "format,compress");
      return u.toString();
    }
    if (u.searchParams.has("resize") || (u.searchParams.has("w") && !host.includes("twitter"))) {
      ["resize", "w", "h", "fit", "strip", "quality"].forEach(p => u.searchParams.delete(p));
      return u.toString();
    }
    const toi = u.pathname.match(/^(.*?)\/thumb\/(\d+)x(\d+)(\/.*)?$/);
    if (toi) { u.pathname = toi[1] + (toi[4] || ""); return u.toString(); }

    if (host.includes("bbci.co.uk") || u.pathname.includes("/ichef/")) {
      u.pathname = u.pathname.replace(/\/\d+\//, "/1280/");
      return u.toString();
    }

    ["width","height","w","h","size","quality","q","maxwidth","maxheight","scale"]
      .forEach(p => u.searchParams.delete(p));
    return u.toString();
  } catch {
    return imageUrl;
  }
}
