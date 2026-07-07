import http from "node:http";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { createHmac, timingSafeEqual } from "node:crypto";
import { TwitterApi } from "twitter-api-v2";

const root = join(process.cwd(), "public");
const port = Number(process.env.PORT || 3000);
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36";
const TEXT_DETAIL_CHAR_LIMIT = 500;

function readSecrets() {
  // Try reading .env as JSON from project dir or parent dir
  const candidates = [
    join(process.cwd(), ".env"),
    join(process.cwd(), "..", ".env")
  ];
  for (const file of candidates) {
    try {
      if (existsSync(file)) {
        const raw = readFileSync(file, "utf-8").trim();
        // Support JSON format: { "pexelsApiKey": "..." }
        if (raw.startsWith("{")) return JSON.parse(raw);
        // Support KEY=VALUE format
        const obj = {};
        for (const line of raw.split("\n")) {
          const match = line.match(/^\s*([A-Za-z_]+)\s*[:=]\s*"?([^"]*)"?\s*$/);
          if (match) obj[match[1]] = match[2];
        }
        return obj;
      }
    } catch { /* ignore */ }
  }
  return {};
}

const secrets = readSecrets();
const pexelsApiKey = process.env.PEXELS_API_KEY || secrets.pexelsApiKey || secrets.PEXELS_API_KEY || "";
if (pexelsApiKey) {
  console.log(`✓ Pexels API key loaded (${pexelsApiKey.slice(0, 6)}…)`);
} else {
  console.warn("⚠ No Pexels API key found. Stock images will not work.");
  console.warn("  Checked: .env in project dir and parent dir, or PEXELS_API_KEY env var.");
}

/* ── Twitter / X (OAuth 1.0a) ── */
const twitterCfg = {
  appKey:       process.env.TWITTER_API_KEY       || secrets.TWITTER_API_KEY,
  appSecret:    process.env.TWITTER_API_SECRET    || secrets.TWITTER_API_SECRET,
  accessToken:  process.env.TWITTER_ACCESS_TOKEN  || secrets.TWITTER_ACCESS_TOKEN,
  accessSecret: process.env.TWITTER_ACCESS_SECRET || secrets.TWITTER_ACCESS_SECRET,
};
const twitterClient = (twitterCfg.appKey && twitterCfg.accessToken)
  ? new TwitterApi(twitterCfg)
  : null;
if (twitterClient) {
  console.log(`✓ Twitter API ready (key ${twitterCfg.appKey.slice(0, 6)}…)`);
} else {
  console.warn("⚠ Twitter keys missing — /api/twitter/post will return 503.");
}

/* ── OpenAI (for AI tweet captions) ── */
const openaiApiKey = process.env.OPENAI_API_KEY || secrets.OPENAI_API_KEY || "";
if (openaiApiKey) {
  console.log(`✓ OpenAI API key loaded (${openaiApiKey.slice(0, 8)}…)`);
} else {
  console.warn("⚠ OPENAI_API_KEY missing — /api/generate-caption will return 503.");
}

const STOPWORDS = new Set([
  "THE", "A", "AN", "AND", "OR", "BUT", "FOR", "WITH", "FROM", "THAT", "THIS", "WILL", "WOULD", "SHOULD", "COULD",
  "SAYS", "SAID", "AFTER", "BEFORE", "ABOUT", "UNDER", "OVER", "INTO", "ONTO", "WITHIN", "WITHOUT", "THROUGH",
  "THEIR", "THEY", "THEM", "THERE", "THEN", "HAVE", "HAS", "HAD", "WAS", "WERE", "ARE", "IS", "BEEN", "BEING",
  "MORE", "MOST", "VERY", "JUST", "ONLY", "ALSO", "NEWS", "LIVE", "BBC", "NEW", "SOME", "SUCH", "YOUR", "OUR",
  "AGAINST", "DURING", "WHILE", "WHERE", "WHEN", "WHAT", "WHICH", "WHO", "WHOM", "WHY", "HOW"
]);


const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8"
};

const server = http.createServer(async (req, res) => {
  if (req.method === "POST" && req.url === "/api/scrape") {
    await handleScrape(req, res);
    return;
  }

  if (req.method === "POST" && req.url === "/api/scrape-article") {
    await handleScrapeArticle(req, res);
    return;
  }

  if (req.method === "GET" && req.url?.startsWith("/api/image?")) {
    await handleImageProxy(req, res);
    return;
  }

  if (req.method === "POST" && req.url === "/api/agent-session") {
    await handleAgentSession(req, res);
    return;
  }

  if (req.method === "GET" && req.url?.startsWith("/api/stock-images?")) {
    await handleStockImages(req, res);
    return;
  }

  if (req.method === "GET" && req.url?.startsWith("/api/google-images?")) {
    await handleGoogleImages(req, res);
    return;
  }

  if (req.method === "GET" && req.url?.startsWith("/api/flux-image?")) {
    await handleFluxImage(req, res);
    return;
  }

  if (req.method === "POST" && req.url === "/api/analyze-image") {
    await handleAnalyzeImage(req, res);
    return;
  }

  if (req.method === "POST" && req.url === "/api/twitter/post") {
    await handleTwitterPost(req, res);
    return;
  }

  if (req.method === "POST" && req.url === "/api/generate-caption") {
    await handleGenerateCaption(req, res);
    return;
  }

  if (req.method === "POST" && req.url === "/api/generate-article") {
    await handleGenerateArticle(req, res);
    return;
  }

  if (req.method === "POST" && req.url === "/api/upscale-image") {
    await handleUpscaleImage(req, res);
    return;
  }

  // Static file serving — URL-decode so paths with %20 (spaces) etc. resolve.
  let urlPath = req.url === "/" ? "/index.html" : req.url;
  // Drop any query string before disk lookup
  const qIdx = urlPath.indexOf("?");
  if (qIdx >= 0) urlPath = urlPath.slice(0, qIdx);
  try { urlPath = decodeURIComponent(urlPath); } catch { /* leave as-is */ }
  const safePath = normalize(urlPath).replace(/^([.][.][/\\])+/, "");
  const filePath = join(root, safePath);

  if (!filePath.startsWith(root) || !existsSync(filePath) || statSync(filePath).isDirectory()) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }

  res.writeHead(200, { "Content-Type": types[extname(filePath).toLowerCase()] || "application/octet-stream" });
  createReadStream(filePath).pipe(res);
});

server.listen(port, () => {
  console.log(`Pix Post Builder running at http://localhost:${port}`);
});

/* ── Web Image Search (multi-source, high quality) ── */

// Strip CDN resize parameters to get original full-resolution images
function upgradeImageUrl(imageUrl) {
  try {
    const u = new URL(imageUrl);

    // Cloudinary: remove transformation path segments
    if (u.hostname.includes("cloudinary.com") || u.hostname.includes("res.cloudinary.com")) {
      u.pathname = u.pathname.replace(/\/c_\w+,[^/]+/g, "").replace(/\/w_\d+[^/]*/g, "").replace(/\/h_\d+[^/]*/g, "");
      return u.toString();
    }

    // imgix: remove resize params, set high quality
    if (u.hostname.includes("imgix.net")) {
      u.searchParams.delete("w"); u.searchParams.delete("h");
      u.searchParams.delete("fit"); u.searchParams.delete("crop");
      u.searchParams.set("q", "100");
      return u.toString();
    }

    // WordPress/Jetpack: strip resize params
    if (u.searchParams.has("resize") || u.searchParams.has("w") || u.searchParams.has("fit")) {
      u.searchParams.delete("resize"); u.searchParams.delete("w"); u.searchParams.delete("h");
      u.searchParams.delete("fit"); u.searchParams.delete("crop");
      return u.toString();
    }

    // Generic: remove common resize params
    for (const key of ["width", "height", "w", "h", "quality", "q", "resize", "size", "maxwidth", "maxheight"]) {
      u.searchParams.delete(key);
    }

    // YouTube: upgrade to maxresdefault
    if (u.hostname.includes("ytimg.com") && u.pathname.includes("hqdefault")) {
      return imageUrl.replace("hqdefault", "maxresdefault");
    }

    return u.toString();
  } catch {
    return imageUrl;
  }
}

// Skip low-quality URLs (favicons, icons, tiny thumbnails)
function isLikelyHighQuality(url) {
  const lower = url.toLowerCase();
  if (lower.includes("favicon")) return false;
  if (lower.includes("/icon")) return false;
  if (lower.match(/\b(16|24|32|48|64|72|96)x\1\b/)) return false;
  if (lower.includes("thumbnail") && !lower.includes("maxresdefault")) return false;
  if (lower.includes("logo") && !lower.includes("article")) return false;
  return true;
}

async function handleGoogleImages(req, res) {
  try {
    const requestUrl = new URL(req.url, `http://localhost:${port}`);
    const query = requestUrl.searchParams.get("query")?.trim();
    if (!query) {
      sendJson(res, 400, { error: "A search query is required." });
      return;
    }

    let images = [];

    // Source 1: Bing (cloud-friendly)
    images = await tryBingImages(query, 8);

    // Source 2: Google (fallback — works locally, may be blocked on cloud)
    if (!images.length) {
      images = await tryGoogleImages(query, 8);
    }

    // Source 3: DuckDuckGo (last resort)
    if (!images.length) {
      images = await tryDuckDuckGoImages(query, 8);
    }

    sendJson(res, 200, { images, source: images.length ? "web" : "none" });
  } catch (error) {
    sendJson(res, 500, { error: error.message || "Image search failed." });
  }
}

async function handleAgentSession(req, res) {
  try {
    const secret = process.env.SHORTLY_AGENT_AUTH_SECRET || secrets.SHORTLY_AGENT_AUTH_SECRET || "";
    if (!secret) {
      sendJson(res, 200, {
        required: false,
        authenticated: true,
        user: null,
      });
      return;
    }

    const body = await readJson(req);
    const token = String(body.token || "").trim();
    if (!token) {
      sendJson(res, 401, {
        required: true,
        authenticated: false,
        error: "Missing Shortly access token.",
      });
      return;
    }

    const payload = verifyShortlyAgentToken(token, secret);
    if (!payload) {
      sendJson(res, 401, {
        required: true,
        authenticated: false,
        error: "Invalid or expired Shortly access token.",
      });
      return;
    }

    sendJson(res, 200, {
      required: true,
      authenticated: true,
      user: {
        loginId: payload.loginId || payload.id || null,
        agentId: payload.agentId || "pix-post-agent",
        username: payload.username || null,
        displayName: payload.displayName || payload.name || payload.username || "Shortly user",
      },
    });
  } catch (error) {
    sendJson(res, 500, { error: error.message || "Agent session check failed." });
  }
}

function verifyShortlyAgentToken(token, secret) {
  const parts = token.split(".");
  if (parts.length !== 2) return null;

  const [payloadPart, signaturePart] = parts;
  const expected = base64UrlEncode(createHmac("sha256", secret).update(payloadPart).digest());
  if (!safeEqual(signaturePart, expected)) return null;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8"));
  } catch {
    return null;
  }

  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && Number(payload.exp) < now) return null;
  if (payload.agentId && payload.agentId !== "pix-post-agent" && payload.agentId !== "pix") return null;
  return payload;
}

function base64UrlEncode(buffer) {
  return Buffer.from(buffer)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

async function handleFluxImage(req, res) {
  try {
    const falKey = process.env.FAL_KEY || secrets.FAL_KEY || secrets.falKey || "";
    if (!falKey) {
      sendJson(res, 503, { error: "FAL_KEY is missing." });
      return;
    }

    const requestUrl = new URL(req.url, `http://localhost:${port}`);
    const query = requestUrl.searchParams.get("query")?.trim();
    const context = requestUrl.searchParams.get("context")?.trim() || "";
    if (!query) {
      sendJson(res, 400, { error: "A prompt is required." });
      return;
    }

    const prompt = buildFluxPrompt(query, context);
    const result = await runFalFlux(falKey, prompt);
    const images = (result.images || [])
      .map((image, index) => {
        const url = image.url;
        return {
          id: `flux-${result.seed || Date.now()}-${index}`,
          alt: query,
          preview: url ? `/api/image?url=${encodeURIComponent(url)}` : null,
          image: url,
          imageProxy: url ? `/api/image?url=${encodeURIComponent(url)}` : null,
          source: "flux",
        };
      })
      .filter((image) => image.preview && image.imageProxy);

    if (!images.length) {
      sendJson(res, 502, { error: "Flux returned no images." });
      return;
    }

    sendJson(res, 200, { images, source: "flux" });
  } catch (error) {
    sendJson(res, 500, { error: error.message || "Flux image generation failed." });
  }
}

async function handleAnalyzeImage(req, res) {
  try {
    const apiKey = process.env.OPENAI_API_KEY || secrets.OPENAI_API_KEY || "";
    if (!apiKey) {
      sendJson(res, 503, { error: "OPENAI_API_KEY is missing." });
      return;
    }

    const body = await readJson(req, { limit: 8_000_000 });
    const imageData = (body.imageData || "").trim();
    if (!imageData || !imageData.startsWith("data:image/")) {
      sendJson(res, 400, { error: "A base64 image data URL is required." });
      return;
    }

    const analysis = await analyzeImageWithOpenAI(apiKey, imageData);
    sendJson(res, 200, { analysis });
  } catch (error) {
    sendJson(res, 500, { error: error.message || "Image analysis failed." });
  }
}

async function analyzeImageWithOpenAI(apiKey, imageData) {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      input: [{
        role: "user",
        content: [
          {
            type: "input_text",
            text: [
              "Analyze this product image for a poster background generator.",
              "Use OCR/text recognition carefully. Also identify repeated patterns, product type, packaging shape, colors, materials, logos, labels, icons, and visible brand cues.",
              "Return only compact JSON with these keys:",
              "visibleText: exact text strings you can read,",
              "productType: short product category,",
              "brandCues: short array,",
              "patterns: short array of visual patterns or repeated motifs,",
              "colors: short array,",
              "promptHints: one concise sentence for image generation.",
              "If no text is readable, visibleText must be an empty array. Do not guess unreadable text.",
            ].join(" "),
          },
          { type: "input_image", image_url: imageData, detail: "high" },
        ],
      }],
      max_output_tokens: 500,
    }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = payload.error?.message || `OpenAI returned ${response.status}`;
    throw new Error(detail);
  }

  const text = extractOpenAIOutputText(payload).trim();
  try {
    return normalizeImageAnalysis(JSON.parse(text.replace(/^```json\s*|\s*```$/g, "")));
  } catch {
    return normalizeImageAnalysis({ promptHints: text });
  }
}

function extractOpenAIOutputText(payload) {
  if (payload.output_text) return payload.output_text;
  const chunks = [];
  for (const item of payload.output || []) {
    for (const content of item.content || []) {
      if (content.type === "output_text" && content.text) chunks.push(content.text);
    }
  }
  return chunks.join("\n");
}

function normalizeImageAnalysis(value) {
  const arrayOfStrings = (items) => Array.isArray(items)
    ? items.map((item) => String(item).trim()).filter(Boolean).slice(0, 8)
    : [];
  return {
    visibleText: arrayOfStrings(value.visibleText),
    productType: String(value.productType || "").trim().slice(0, 120),
    brandCues: arrayOfStrings(value.brandCues),
    patterns: arrayOfStrings(value.patterns),
    colors: arrayOfStrings(value.colors),
    promptHints: String(value.promptHints || "").trim().slice(0, 500),
  };
}

function buildFluxPrompt(query, context = "") {
  const parts = [
    "Create a high-quality editorial news background image.",
    `Subject: ${query}.`,
  ];
  if (context) {
    parts.push(`Use these product-image recognition details as visual guidance: ${context}.`);
    parts.push("Respect any readable product text exactly if it appears, and preserve the identified pattern/motif style without inventing fake labels.");
  }
  parts.push(
    "Photorealistic, dramatic but natural lighting, sharp focus, premium newsroom/social poster style.",
    "Do not add unrelated text, captions, fake logos, or watermarks.",
  );
  return parts.join(" ");
}

async function runFalFlux(falKey, prompt) {
  const response = await fetch("https://fal.run/fal-ai/flux/schnell", {
    method: "POST",
    headers: {
      "Authorization": `Key ${falKey}`,
      "Content-Type": "application/json",
      "X-Fal-Store-IO": "0",
    },
    body: JSON.stringify({
      prompt,
      image_size: "portrait_16_9",
      num_images: 1,
      enable_safety_checker: true,
      output_format: "jpeg",
    }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = payload.detail || payload.error || `fal returned ${response.status}`;
    throw new Error(Array.isArray(detail) ? detail.map((item) => item.msg || item.message || String(item)).join("; ") : detail);
  }
  return payload;
}

async function tryBingImages(query, max) {
  try {
    // filterui:imagesize-wallpaper = extra large images only
    const bingUrl = `https://www.bing.com/images/search?q=${encodeURIComponent(query)}&qft=+filterui:imagesize-wallpaper&form=IRFLTR&first=1`;
    const response = await fetch(bingUrl, {
      headers: {
        "user-agent": USER_AGENT,
        "accept": "text/html,application/xhtml+xml",
        "accept-language": "en-US,en;q=0.9"
      }
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
        id: results.length,
        alt: "Related Image",
        preview: `/api/image?url=${encodeURIComponent(upgraded)}`,
        image: upgraded,
        imageProxy: `/api/image?url=${encodeURIComponent(upgraded)}`,
        source: "bing"
      });
    }

    // If wallpaper size returned nothing, try large
    if (!results.length) {
      const fallbackUrl = `https://www.bing.com/images/search?q=${encodeURIComponent(query)}&qft=+filterui:imagesize-large&form=IRFLTR&first=1`;
      const fbRes = await fetch(fallbackUrl, {
        headers: { "user-agent": USER_AGENT, "accept": "text/html,application/xhtml+xml", "accept-language": "en-US,en;q=0.9" }
      });
      if (fbRes.ok) {
        const fbHtml = await fbRes.text();
        const fbMatches = fbHtml.matchAll(/"murl"\s*:\s*"(https?:[^"]+)"/gi);
        for (const m of fbMatches) {
          if (results.length >= max) break;
          let url = m[1].replace(/\\u002f/gi, "/").replace(/\\u0026/gi, "&");
          if (url.includes("bing.com") || url.includes("bing.net") || url.includes("microsoft.com")) continue;
          if (!isLikelyHighQuality(url)) continue;
          if (seen.has(url)) continue;
          seen.add(url);
          const upgraded = upgradeImageUrl(url);
          results.push({
            id: results.length,
            alt: "Related Image",
            preview: `/api/image?url=${encodeURIComponent(upgraded)}`,
            image: upgraded,
            imageProxy: `/api/image?url=${encodeURIComponent(upgraded)}`,
            source: "bing"
          });
        }
      }
    }

    return results;
  } catch { return []; }
}

async function tryGoogleImages(query, max) {
  try {
    // tbs=isz:lt,islt:2mp = images larger than 2 megapixels
    const googleUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}&tbm=isch&tbs=isz:lt,islt:2mp`;
    const response = await fetch(googleUrl, {
      headers: {
        "user-agent": USER_AGENT,
        "accept": "text/html,application/xhtml+xml",
        "accept-language": "en-US,en;q=0.9"
      }
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
        id: results.length,
        alt: "Google Image",
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

    const ddgUrl = `https://duckduckgo.com/i.js?l=us-en&o=json&q=${encodeURIComponent(query)}&vqd=${vqd}&f=size:Large&p=1`;
    const ddgRes = await fetch(ddgUrl, {
      headers: { "user-agent": USER_AGENT, "accept": "application/json" }
    });
    if (!ddgRes.ok) return [];
    const data = await ddgRes.json();

    return (data.results || []).filter(r => isLikelyHighQuality(r.image || "")).slice(0, max).map((r, i) => {
      const upgraded = upgradeImageUrl(r.image);
      return {
        id: i,
        alt: r.title || "DuckDuckGo Image",
        preview: `/api/image?url=${encodeURIComponent(r.thumbnail || upgraded)}`,
        image: upgraded,
        imageProxy: `/api/image?url=${encodeURIComponent(upgraded)}`,
        source: "duckduckgo"
      };
    });
  } catch { return []; }
}

async function handleScrape(req, res) {
  try {
    const body = await readJson(req);
    const targetUrl = body?.url;

    if (!targetUrl) {
      sendJson(res, 400, { error: "A URL is required." });
      return;
    }

    const parsedUrl = new URL(targetUrl);
    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
      sendJson(res, 400, { error: "Only http and https URLs are supported." });
      return;
    }

    const response = await fetch(parsedUrl, { headers: { "user-agent": USER_AGENT } });
    if (!response.ok) {
      sendJson(res, 502, { error: `Source returned ${response.status}.` });
      return;
    }

    const html = await response.text();
    const candidates = extractItems(html, parsedUrl);
    const items = await enrichItems(candidates);
    sendJson(res, 200, { items });
  } catch (error) {
    sendJson(res, 500, { error: error.message || "Scrape failed." });
  }
}

async function handleScrapeArticle(req, res) {
  try {
    const body = await readJson(req);
    const targetUrl = body?.url;

    if (!targetUrl) {
      sendJson(res, 400, { error: "A URL is required." });
      return;
    }

    const parsedUrl = new URL(targetUrl);
    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
      sendJson(res, 400, { error: "Only http and https URLs are supported." });
      return;
    }

    const response = await fetch(parsedUrl, { headers: { "user-agent": USER_AGENT } });
    if (!response.ok) {
      sendJson(res, 502, { error: `Source returned ${response.status}.` });
      return;
    }

    const html = await response.text();

    // Extract title: og:title > twitter:title > <title> tag
    let title = extractMetaContent(html, ["og:title", "twitter:title"]);
    if (!title) {
      const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      title = titleMatch ? cleanupText(stripTags(titleMatch[1])) : "";
    }
    // Strip any leftover HTML tags and clean up
    title = cleanupText(stripTags(title));
    // Clean up common suffixes like " - BBC News", " | Times of India"
    title = title.replace(/\s*[-|–—]\s*[^-|–—]{2,30}$/i, "").trim();

    // Extract image: try secure_url first, then og:image, twitter:image
    let image = extractMetaContent(html, ["og:image:secure_url", "og:image", "twitter:image", "twitter:image:src"]);
    if (image) {
      image = resolveMaybeRelative(image, targetUrl);
      image = upgradeImageToHighestQuality(image);
    }

    if (!title) {
      sendJson(res, 422, { error: "Could not extract a title from this page." });
      return;
    }

    const metaDescription = extractMetaContent(html, ["og:description", "twitter:description", "description"]);
    const articleText = extractArticleText(html, title);

    // Entity-focused image search query via gpt-4o-mini (fail-soft). The old
    // client-side keyword extractor produced garbage like "KARAN JOHARS
    // DHARMA PRODUCTIONS SEALS" → sports photos for a Bollywood story.
    const imageQuery = await buildImageSearchQuery(title, articleText);

    sendJson(res, 200, {
      title: cleanupText(title),
      image: image || null,
      imageProxy: image ? `/api/image?url=${encodeURIComponent(image)}` : null,
      sourceUrl: targetUrl,
      articleText,
      detailText: limitCharacters(articleText || metaDescription || title, TEXT_DETAIL_CHAR_LIMIT),
      imageQuery,
    });
  } catch (error) {
    sendJson(res, 500, { error: error.message || "Article scrape failed." });
  }
}

/* Ask gpt-4o-mini for a 3-6 word image-search query: the names/entities a
   photo editor would search for. ~$0.0001, fails soft to "". */
async function buildImageSearchQuery(title, articleText = "") {
  if (!openaiApiKey || !title) return "";
  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${openaiApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [{
          role: "user",
          content:
            "You pick image-search queries for news posters. Given the story below, output ONLY a 3-6 word search query — the specific people, places or things a photo editor would search to find a fitting photo. Prefer full person names. No numbers, currencies, quotes or filler words.\n\n" +
            `Headline: ${title}\n` +
            (articleText ? `Article: ${articleText.slice(0, 500)}` : ""),
        }],
        temperature: 0.2,
        max_tokens: 24,
      }),
    });
    if (!r.ok) return "";
    const data = await r.json();
    const q = (data?.choices?.[0]?.message?.content || "")
      .replace(/["'\n]/g, " ").replace(/\s+/g, " ").trim();
    if (q) console.log(`✓ image query: "${q}"`);
    return q.slice(0, 80);
  } catch {
    return "";
  }
}

async function handleStockImages(req, res) {
  try {
    if (!pexelsApiKey) {
      sendJson(res, 500, { error: "Pexels API key is missing." });
      return;
    }

    const requestUrl = new URL(req.url, `http://localhost:${port}`);
    const query = requestUrl.searchParams.get("query")?.trim();
    if (!query) {
      sendJson(res, 400, { error: "A search query is required." });
      return;
    }

    const pexelsUrl = new URL("https://api.pexels.com/v1/search");
    pexelsUrl.searchParams.set("query", query);
    pexelsUrl.searchParams.set("per_page", "6");
    pexelsUrl.searchParams.set("orientation", "portrait");

    const response = await fetch(pexelsUrl, {
      headers: {
        Authorization: pexelsApiKey,
        "user-agent": USER_AGENT
      }
    });

    if (!response.ok) {
      sendJson(res, 502, { error: `Pexels returned ${response.status}.` });
      return;
    }

    const payload = await response.json();
    const images = (payload.photos || []).map((photo) => ({
      id: photo.id,
      alt: photo.alt || query,
      photographer: photo.photographer || "Pexels",
      pageUrl: photo.url,
      preview: photo.src?.medium || photo.src?.large || photo.src?.original,
      image: photo.src?.large2x || photo.src?.large || photo.src?.original,
      imageProxy: photo.src?.large2x || photo.src?.large || photo.src?.original
        ? `/api/image?url=${encodeURIComponent(photo.src?.large2x || photo.src?.large || photo.src?.original)}`
        : null
    })).filter((item) => item.preview && item.imageProxy);

    sendJson(res, 200, { images });
  } catch (error) {
    sendJson(res, 500, { error: error.message || "Image search failed." });
  }
}

async function handleImageProxy(req, res) {
  try {
    const requestUrl = new URL(req.url, `http://localhost:${port}`);
    const target = requestUrl.searchParams.get("url");
    if (!target) {
      sendJson(res, 400, { error: "Image URL is required." });
      return;
    }

    const parsed = new URL(target);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      sendJson(res, 400, { error: "Only http and https image URLs are supported." });
      return;
    }

    const response = await fetch(parsed, { headers: { "user-agent": USER_AGENT } });
    if (!response.ok) {
      sendJson(res, 502, { error: `Image source returned ${response.status}.` });
      return;
    }

    const contentType = response.headers.get("content-type") || "application/octet-stream";
    const buffer = Buffer.from(await response.arrayBuffer());
    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*"
    });
    res.end(buffer);
  } catch (error) {
    sendJson(res, 500, { error: error.message || "Image proxy failed." });
  }
}

function extractItems(html, baseUrl) {
  const matches = [...html.matchAll(/<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)];
  const items = [];
  const seen = new Set();

  for (const match of matches) {
    const href = match[1]?.trim();
    const rawInner = match[2] ?? "";
    const title = cleanupText(stripTags(rawInner));
    if (!href || !looksLikeHeadline(title)) {
      continue;
    }

    let absoluteUrl;
    try {
      absoluteUrl = new URL(href, baseUrl).toString();
    } catch {
      continue;
    }

    if (!looksLikeArticleUrl(absoluteUrl, baseUrl)) {
      continue;
    }

    const normalizedKey = `${normalizeText(title)}|${normalizeUrl(absoluteUrl)}`;
    if (seen.has(normalizedKey)) {
      continue;
    }

    seen.add(normalizedKey);
    items.push({
      title: trimTitle(title),
      url: absoluteUrl,
      image: extractImageUrl(rawInner, baseUrl)
    });

    if (items.length >= 16) {
      break;
    }
  }

  return items;
}

async function enrichItems(items) {
  const enriched = [];

  for (const item of items) {
    const next = { ...item };
    try {
      const response = await fetch(item.url, { headers: { "user-agent": USER_AGENT } });
      if (response.ok) {
        const html = await response.text();
        const metaTitle = extractMetaContent(html, ["og:title", "twitter:title"]);
        const metaImage = extractMetaContent(html, ["og:image", "twitter:image", "twitter:image:src"]);
        if (metaTitle && looksLikeHeadline(metaTitle)) {
          next.title = trimTitle(cleanupText(metaTitle));
        }
        if (metaImage) {
          next.image = resolveMaybeRelative(metaImage, item.url);
        }
      }
    } catch {
    }

    next.posterText = next.posterText || buildPosterText(next.title, "", "");
    next.keywords = next.keywords?.length ? next.keywords : extractKeywords(next.title, next.posterText);
    next.imageProxy = next.image ? `/api/image?url=${encodeURIComponent(next.image)}` : null;
    enriched.push(next);
  }

  return enriched.filter((item, index, array) => array.findIndex((candidate) => normalizeUrl(candidate.url) === normalizeUrl(item.url)) === index);
}

function extractMetaContent(html, names) {
  for (const name of names) {
    const propertyRegex = new RegExp(`<meta[^>]+(?:property|name)=["']${escapeForRegex(name)}["'][^>]+content=["']([^"']+)["'][^>]*>`, "i");
    const contentFirstRegex = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${escapeForRegex(name)}["'][^>]*>`, "i");
    const match = html.match(propertyRegex) || html.match(contentFirstRegex);
    if (match?.[1]) {
      return decodeHtmlEntities(match[1]);
    }
  }
  return null;
}

function extractImageUrl(htmlChunk, baseUrl) {
  const src = findAttributeValue(htmlChunk, ["src", "data-src", "data-lazy-src", "data-original"]);
  const srcset = findAttributeValue(htmlChunk, ["srcset", "data-srcset"]);
  const candidate = src || firstSrcFromSet(srcset);
  return candidate ? resolveMaybeRelative(candidate, baseUrl) : null;
}

function findAttributeValue(htmlChunk, names) {
  for (const name of names) {
    const regex = new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, "i");
    const match = htmlChunk.match(regex);
    if (match?.[1]) {
      return match[1];
    }
  }
  return null;
}

function resolveMaybeRelative(value, baseUrl) {
  try {
    return new URL(value.trim(), baseUrl).toString();
  } catch {
    return null;
  }
}

function firstSrcFromSet(value) {
  if (!value) {
    return null;
  }
  return value.split(",")[0]?.trim().split(/\s+/)[0] || null;
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

    // --- Cloudinary ---
    if (host.includes("cloudinary.com")) {
      // Replace upload transformations with just w_auto,q_auto:best
      u.pathname = u.pathname.replace(/\/upload\/[^/]+\//, "/upload/q_auto:best,f_auto/");
      return u.toString();
    }

    // --- imgix ---
    if (host.includes("imgix.net") || u.searchParams.has("ixid")) {
      u.searchParams.delete("w");
      u.searchParams.delete("h");
      u.searchParams.delete("fit");
      u.searchParams.delete("crop");
      u.searchParams.delete("q");
      u.searchParams.delete("auto");
      u.searchParams.set("q", "100");
      u.searchParams.set("auto", "format,compress");
      return u.toString();
    }

    // --- WordPress / Jetpack resize (e.g. ?resize=800,450 or ?w=800) ---
    if (u.searchParams.has("resize") || (u.searchParams.has("w") && !host.includes("twitter"))) {
      u.searchParams.delete("resize");
      u.searchParams.delete("w");
      u.searchParams.delete("h");
      u.searchParams.delete("fit");
      u.searchParams.delete("strip");
      u.searchParams.delete("quality");
      return u.toString();
    }

    // --- Times of India / HT Media (thumb/ in path) ---
    const toi = u.pathname.match(/^(.*?)\/thumb\/(\d+)x(\d+)(\/.*)?$/);
    if (toi) {
      u.pathname = toi[1] + (toi[4] || "");
      return u.toString();
    }

    // --- BBC / Akamai image service (/ichef/) ---
    if (host.includes("bbci.co.uk") || u.pathname.includes("/ichef/")) {
      u.pathname = u.pathname.replace(/\/\d+\//, "/1280/");
      return u.toString();
    }

    // --- Generic: strip common resize query params ---
    ["width", "height", "w", "h", "size", "quality", "q", "maxwidth", "maxheight", "scale"].forEach(p => {
      u.searchParams.delete(p);
    });

    return u.toString();
  } catch {
    return imageUrl;
  }
}

function looksLikeHeadline(value) {
  if (!value) {
    return false;
  }
  const text = cleanupText(value);
  const words = text.split(/\s+/).filter(Boolean);
  if (text.length < 30 || text.length > 180) {
    return false;
  }
  if (words.length < 5 || words.length > 28) {
    return false;
  }
  if (/^(sign in|home|live|menu|search|open source|bbc news|british broadcasting corporation)$/i.test(text)) {
    return false;
  }
  return /[a-zA-Z]/.test(text);
}

function looksLikeArticleUrl(candidate, baseUrl) {
  const url = new URL(candidate);
  const base = new URL(baseUrl);
  if (!["http:", "https:"].includes(url.protocol)) {
    return false;
  }
  const path = url.pathname.toLowerCase();
  if (url.origin === base.origin && (path === "/" || path === "")) {
    return false;
  }
  if (/\/(signin|account|weather|sport\/scores-and-fixtures|newsround)$/.test(path)) {
    return false;
  }
  return path.split("/").filter(Boolean).length >= 1;
}

function trimTitle(value) {
  return value.length > 110 ? `${value.slice(0, 107).trimEnd()}...` : value;
}

function escapeForRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeText(value) {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function normalizeUrl(value) {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return value;
  }
}

function readJson(req, options = {}) {
  const limit = options.limit || 1_000_000;
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > limit) {
        reject(new Error("Request body too large."));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Invalid JSON body."));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function extractArticleText(html, title = "") {
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<(?:header|footer|nav|aside|form|button)\b[\s\S]*?<\/(?:header|footer|nav|aside|form|button)>/gi, " ");

  const scopes = extractArticleScopes(stripped);
  const scoredScopes = scopes.map((scope, index) => {
    const paragraphs = extractParagraphCandidates(scope.html, title);
    const score = paragraphs.reduce((sum, item) => sum + item.score, 0) + scope.priority - index;
    return { paragraphs, score };
  });

  scoredScopes.sort((a, b) => b.score - a.score);
  const best = scoredScopes.find((scope) => scope.paragraphs.length >= 2) || scoredScopes[0];
  return (best?.paragraphs || []).slice(0, 10).map((item) => item.text).join(" ");
}

function extractArticleScopes(html) {
  const scopes = [];
  const scopePatterns = [
    { regex: /<article\b[^>]*>([\s\S]*?)<\/article>/gi, priority: 120 },
    { regex: /<main\b[^>]*>([\s\S]*?)<\/main>/gi, priority: 80 },
    { regex: /<(?:section|div)\b[^>]*(?:class|id)=["'][^"']*(?:article|story|content|entry|post|body)[^"']*["'][^>]*>([\s\S]*?)<\/(?:section|div)>/gi, priority: 55 },
  ];

  for (const pattern of scopePatterns) {
    let match;
    while ((match = pattern.regex.exec(html)) !== null) {
      scopes.push({ html: match[1], priority: pattern.priority });
    }
  }

  scopes.push({ html, priority: 0 });
  return scopes;
}

function extractParagraphCandidates(scope, title) {
  const seen = new Set();
  const candidates = [];
  for (const match of scope.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)) {
    const text = cleanupText(stripTags(match[1] || ""));
    const key = normalizeText(text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const score = scoreArticleParagraph(text, title);
    if (score > 0) candidates.push({ text, score });
  }
  return candidates;
}

function scoreArticleParagraph(text, title = "") {
  const normalized = normalizeText(text);
  const words = normalized.split(/\s+/).filter(Boolean);
  if (text.length < 45 || text.length > 1200 || words.length < 8) return 0;
  if (title && normalizeText(title) === normalized) return 0;
  if (isBoilerplateParagraph(normalized)) return 0;

  const sentenceCount = (text.match(/[.!?](?:\s|$)/g) || []).length;
  const hasNewsTerms = /\b(said|according|reported|minister|police|court|government|company|team|match|official|source|agency|statement)\b/i.test(text);

  // Relevance: paragraphs that mention the story's own proper nouns (from
  // the title) far outrank generic page copy like author bios. "Ranbir
  // Kapoor" appearing in a paragraph is a much stronger signal than length.
  let overlapBonus = 0;
  if (title) {
    const titleNouns = (title.match(/\b[A-Z][a-zA-Z''-]{3,}\b/g) || [])
      .map((w) => w.toLowerCase())
      .filter((w, i, a) => a.indexOf(w) === i);
    const hits = titleNouns.filter((n) => normalized.includes(n)).length;
    overlapBonus = Math.min(hits, 3) * 140;
  }

  return Math.min(text.length, 320) + sentenceCount * 35 + (hasNewsTerms ? 80 : 0) + overlapBonus;
}

function isBoilerplateParagraph(normalized) {
  return /\b(privacy policy|cookie policy|cookies|terms of use|sign in|sign up|subscribe|subscription|advertisement|sponsored|newsletter|all rights reserved|copyright|follow us|read more|related stories|enable javascript|disable ad blocker|allow notifications|manage settings|accept all|our privacy policy has been revised|please review updated privacy policy|news desk|entertainment desk|sports desk|is a dynamic and dedicated team|team of journalists|bring the pulse|about the author|written by|contributed to this report|catch all the|stay updated with|download the app|for more (?:updates|news)|end of article)\b/i.test(normalized);
}

function limitWords(value, maxWords) {
  const words = cleanupText(value || "").split(/\s+/).filter(Boolean);
  return words.slice(0, maxWords).join(" ");
}

function limitCharacters(value, maxChars) {
  const text = cleanupText(value || "");
  if (text.length <= maxChars) return text;
  const clipped = text.slice(0, maxChars + 1);
  const boundary = clipped.lastIndexOf(" ");
  return clipped.slice(0, boundary > Math.floor(maxChars * 0.84) ? boundary : maxChars).trim();
}

function buildPosterText(title, metaDescription, articleText) {
  const source = cleanupText(metaDescription || articleText || title);
  const sentences = source.split(/(?<=[.!?])\s+/).map((part) => part.trim()).filter(Boolean);
  let summary = "";
  for (const sentence of sentences) {
    const candidate = `${summary} ${sentence}`.trim();
    if (candidate.length > 120) {
      break;
    }
    summary = candidate;
    if (summary.length >= 72) {
      break;
    }
  }
  const output = summary || source;
  return output.length > 120 ? `${output.slice(0, 117).trimEnd()}...` : output;
}

function extractKeywords(title, posterText) {
  const found = [];
  const phraseMatches = cleanupText(title).match(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2}|[A-Z]{2,})\b/g) || [];
  for (const match of phraseMatches) {
    const upper = match.toUpperCase();
    if (!STOPWORDS.has(upper) && !found.includes(upper)) {
      found.push(upper);
    }
    if (found.length >= 3) {
      return found;
    }
  }

  const frequency = new Map();
  for (const word of cleanupText(`${title} ${posterText}`).toUpperCase().match(/[A-Z]{3,}/g) || []) {
    if (STOPWORDS.has(word) || word.length < 4) {
      continue;
    }
    frequency.set(word, (frequency.get(word) || 0) + 1);
  }

  for (const word of [...frequency.entries()].sort((a, b) => b[1] - a[1]).map(([word]) => word)) {
    if (!found.includes(word)) {
      found.push(word);
    }
    if (found.length >= 4) {
      break;
    }
  }

  return found.slice(0, 4);
}

/* ── Twitter / X — Post poster image with caption ── */
async function handleTwitterPost(req, res) {
  if (!twitterClient) {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Twitter not configured. Set TWITTER_* keys in .env." }));
    return;
  }

  try {
    const caption = decodeURIComponent(req.headers["x-caption"] || "").trim();
    if (!caption) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing X-Caption header." }));
      return;
    }
    if (caption.length > 280) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Caption is ${caption.length} chars; max is 280.` }));
      return;
    }

    // Read raw PNG body into a buffer (10 MB safety cap)
    const MAX_BYTES = 10 * 1024 * 1024;
    const chunks = [];
    let total = 0;
    for await (const chunk of req) {
      total += chunk.length;
      if (total > MAX_BYTES) {
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Image exceeds 10 MB." }));
        return;
      }
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);
    if (buffer.length < 100) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Empty or invalid image body." }));
      return;
    }

    console.log(`→ Twitter post: ${buffer.length} bytes, caption "${caption.slice(0, 40)}…"`);

    // 1) Upload media (v1.1 endpoint, OAuth 1.0a)
    const mediaId = await twitterClient.v1.uploadMedia(buffer, { mimeType: "image/png" });

    // 2) Create tweet (v2) referencing the media
    const tweet = await twitterClient.v2.tweet({
      text: caption,
      media: { media_ids: [mediaId] },
    });

    const tweetId = tweet?.data?.id;
    const tweetUrl = tweetId ? `https://x.com/i/status/${tweetId}` : null;
    console.log(`✓ Tweet posted: ${tweetUrl}`);

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, tweetUrl, id: tweetId }));
  } catch (err) {
    const code = err?.code || err?.data?.status || err?.status || 500;
    const msg  = err?.data?.detail || err?.data?.errors?.[0]?.message || err?.message || "Twitter post failed.";
    console.error("✗ Twitter post error:", code, msg);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: msg, code }));
  }
}

/* ── OpenAI — generate AI tweet caption + hashtags from a headline ── */
async function handleGenerateCaption(req, res) {
  if (!openaiApiKey) {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "OPENAI_API_KEY not set on server." }));
    return;
  }

  try {
    // Read JSON body
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf-8");
    let body = {};
    try { body = JSON.parse(raw || "{}"); } catch { /* ignore */ }

    const headline = (body.headline || "").trim();
    if (!headline) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing 'headline' in body." }));
      return;
    }

    const systemPrompt = [
      "You are a senior social-media editor at a news outlet. You write tweets that accompany a news image poster — the image already shows the headline, so the tweet adds VALUE on top.",
      "",
      "Goal: make people stop scrolling and engage.",
      "",
      "RULES (follow strictly):",
      "1. NEVER repeat the headline verbatim. Rewrite it as a hook: a sharp angle, a question, a striking fact, or a one-line takeaway.",
      "2. Write 1–2 short sentences. Punchy. Active voice. No filler words ('In a major development', 'It is reported that', etc.).",
      "3. Add 2–4 hashtags at the end, each highly relevant — mix one broad (e.g. #IndianPolitics) with one specific (e.g. #TamilNadu, #DMK). No #BreakingNews unless it actually is. Hashtags must be CamelCase, no spaces, no special chars.",
      "4. Total length ≤ 270 characters INCLUDING hashtags. Count carefully.",
      "5. Tone: neutral and professional for politics/conflict/tragedy. Conversational and curious for tech/business/culture. Light-hearted (still classy) for entertainment/sports.",
      "6. No emojis. No clickbait phrasing ('You won't believe…'). No moralizing. No editorializing on contested issues — stay factual.",
      "7. Output ONLY the final tweet text. No quotes, no labels, no preamble, no explanation.",
      "",
      "EXAMPLES of the style we want:",
      "",
      "Headline: \"Modi tables Finance Bill 2026 in Parliament amid opposition uproar\"",
      "Tweet: Finance Bill 2026 hits the floor — and the opposition isn't letting it pass quietly. Key clauses on capital gains and digital tax are already drawing fire. #FinanceBill2026 #Parliament #IndianPolitics",
      "",
      "Headline: \"Apple unveils Vision Pro 2 with 50% lighter design at WWDC\"",
      "Tweet: Apple's second swing at spatial computing is half the weight — and apparently twice the battery life. The price tag? Still TBD. #VisionPro2 #WWDC #Apple",
      "",
      "Headline: \"India crowned T20 World Cup champions after 11-year drought\"",
      "Tweet: 11 years. One trophy back home. India's T20 wait is over. #T20WorldCup #TeamIndia #Cricket"
    ].join("\n");

    const t0 = Date.now();
    const aiRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${openaiApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: `Headline:\n${headline}` },
        ],
        temperature: 0.8,
        max_tokens: 140,
      }),
    });

    if (!aiRes.ok) {
      const errText = await aiRes.text().catch(() => "");
      console.error(`✗ OpenAI ${aiRes.status}:`, errText.slice(0, 300));
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `OpenAI ${aiRes.status}`, detail: errText.slice(0, 200) }));
      return;
    }

    const data = await aiRes.json();
    let caption = data?.choices?.[0]?.message?.content?.trim() || "";

    // Strip surrounding quotes if model added any
    caption = caption.replace(/^["“”']+|["“”']+$/g, "").trim();

    // Hard-trim to 280 just in case
    if (caption.length > 280) caption = caption.slice(0, 277) + "…";

    const ms = Date.now() - t0;
    console.log(`✓ AI caption (${ms}ms, ${caption.length} chars): "${caption.slice(0, 60)}…"`);

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ caption }));
  } catch (err) {
    console.error("✗ generate-caption error:", err);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err.message || "Caption generation failed." }));
  }
}

/* ── OpenAI — full article package (headline + 4 bullets + tweet) ──
   Local-dev mirror of api/generate-article.js. Editorial rules live in the
   shared prompt below; keep both copies in sync when editing. */
const EDITORIAL_SYSTEM_PROMPT = [
  "You are a news sub-editor at Shortly. Given a source headline (and article text when available), produce a news package in STRICT JSON with this exact shape:",
  "",
  '{ "headline": string, "bullets": [string, string, string, string], "tweet": string, "flags": [string] }',
  "",
  "FORMAT RULES:",
  "1. headline: max 60 characters. Newspaper style. Correct sentence capitalisation (capitalise first word and proper nouns only). No repeated phrases from the bullets. No periods in initials (write PM, US, UK — never P.M., U.S.).",
  "2. bullets: exactly 4 single-line bullet points covering the most important parts of the news. Each one short enough to read in a glance. Do not repeat the headline's phrasing.",
  "3. tweet: within 280 characters. No dashes of any kind. British English spelling (organise, colour, labour). Facts first — lead with what happened, not opinion. May end with 1-2 relevant hashtags if room allows.",
  "",
  "EDITORIAL RULES:",
  "- Verify claims against the provided source text; if a claim in the headline is not supported by the text, or the story touches something sensitive, add a short note to flags (empty array if none).",
  "- No em dashes anywhere. Keep the writing flowy and clear.",
  "- No quotes unless verbatim from the source with the person's name attributed.",
  "- Simple, conversational but formal language. No jargon.",
  "- No visual dividers, no markdown, no emojis.",
  "- Safe-reporting standards for deaths, suicide, and sensitive stories: no method details, no sensationalising, neutral tone.",
  "- If the story is a tragedy (death, suicide, disaster), the tweet must NOT carry a promotional call-to-action; where appropriate for suicide stories include a helpline line instead (e.g. 'Help is available. Call iCall at 9152987821 (India).').",
  "- Neutral political framing: attribute claims to both sides, never take a side.",
  "",
  "Output ONLY the JSON object. No prose around it.",
].join("\n");

async function handleGenerateArticle(req, res) {
  if (!openaiApiKey) {
    sendJson(res, 503, { error: "OPENAI_API_KEY not set on server." });
    return;
  }

  try {
    const body = await readJson(req);
    const headline = (body?.headline || "").trim();
    const sourceUrl = (body?.sourceUrl || "").trim();
    if (!headline) {
      sendJson(res, 400, { error: "Missing 'headline' in body." });
      return;
    }

    // Ground the model with the actual article text when we have a URL.
    let articleText = "";
    if (sourceUrl) {
      try {
        const r = await fetch(sourceUrl, { headers: { "user-agent": USER_AGENT } });
        if (r.ok) {
          const html = await r.text();
          const articleMatch = html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i);
          const scope = articleMatch?.[1] || html;
          articleText = [...scope.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
            .map((m) => cleanupText(stripTags(m[1] || "")))
            .filter((t) => t.length >= 50 && t.length <= 500)
            .filter((t) => !/^(sign up|read more|copyright|follow live|watch:|also read)/i.test(t))
            .slice(0, 10)
            .join("\n");
        }
      } catch { /* grounding is best-effort */ }
    }

    const userContent = articleText
      ? `Source headline:\n${headline}\n\nArticle text:\n${articleText}`
      : `Source headline:\n${headline}\n\n(No article text available — write from the headline only and flag that facts could not be verified against source text.)`;

    const t0 = Date.now();
    const aiRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${openaiApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: EDITORIAL_SYSTEM_PROMPT },
          { role: "user", content: userContent },
        ],
        temperature: 0.6,
        max_tokens: 600,
      }),
    });

    if (!aiRes.ok) {
      const errText = await aiRes.text().catch(() => "");
      console.error(`✗ OpenAI ${aiRes.status}:`, errText.slice(0, 300));
      sendJson(res, 502, { error: `OpenAI ${aiRes.status}`, detail: errText.slice(0, 200) });
      return;
    }

    const data = await aiRes.json();
    let parsed = {};
    try { parsed = JSON.parse(data?.choices?.[0]?.message?.content || "{}"); } catch { /* handled below */ }

    const out = {
      headline: (parsed.headline || "").slice(0, 80),
      bullets: Array.isArray(parsed.bullets) ? parsed.bullets.slice(0, 4).map(String) : [],
      tweet: (parsed.tweet || "").slice(0, 280),
      flags: Array.isArray(parsed.flags) ? parsed.flags.map(String) : [],
    };
    if (!out.headline || out.bullets.length < 4 || !out.tweet) {
      sendJson(res, 502, { error: "AI returned an incomplete package.", raw: parsed });
      return;
    }

    console.log(`✓ AI article (${Date.now() - t0}ms): "${out.headline}"`);
    sendJson(res, 200, out);
  } catch (err) {
    console.error("✗ generate-article error:", err);
    sendJson(res, 500, { error: err.message || "Article generation failed." });
  }
}

/* ── OpenAI — context-aware, identity-preserving background enhance ──
   Local-dev mirror of api/upscale-image.js. Two stages:
     1. gpt-4o-mini vision describes the photo (people, faces, text, setting)
     2. gpt-image-1 (quality=high, input_fidelity=high) enhances with that
        description embedded so it knows what it must NOT change. */

const VISION_PROMPT =
  "You are assisting a photo-restoration pipeline for a news organisation. " +
  "Describe this photograph in 2-4 sentences, factually and precisely: the people " +
  "(count, apparent age, facial hair, glasses, expressions, clothing), any visible text, " +
  "logos or signage (quote them exactly), the setting, and the lighting. " +
  "Do NOT guess names. Output only the description.";

function buildEnhancePrompt(description, headline) {
  return [
    "Professional photo restoration of a REAL news photograph.",
    description ? `CONTEXT — the photo shows: ${description}` : "",
    headline ? `It accompanies this news story: "${headline}".` : "",
    "",
    "TASK: upscale and enhance only — recover fine detail, increase sharpness,",
    "remove compression artifacts and noise, correct exposure and colour balance.",
    "",
    "ABSOLUTE RULES:",
    "- Every person's face must stay PIXEL-FAITHFUL to the original identity:",
    "  same facial structure, skin texture, wrinkles, expression and age.",
    "  Do NOT beautify, smooth skin, or idealise anyone.",
    "- Reproduce all text, logos and signage exactly as written.",
    "- Identical composition, framing, colours and content.",
    "- Add nothing. Remove nothing. This is journalism, not art.",
  ].filter(Boolean).join("\n");
}

async function describeImageForEnhance(buffer, mime) {
  try {
    const dataUrl = `data:${mime};base64,${buffer.toString("base64")}`;
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${openaiApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [{
          role: "user",
          content: [
            { type: "text", text: VISION_PROMPT },
            { type: "image_url", image_url: { url: dataUrl, detail: "low" } },
          ],
        }],
        temperature: 0.2,
        max_tokens: 220,
      }),
    });
    if (!r.ok) {
      console.warn(`⚠ vision describe failed (${r.status}) — enhancing without context`);
      return "";
    }
    const data = await r.json();
    return (data?.choices?.[0]?.message?.content || "").trim();
  } catch (e) {
    console.warn("⚠ vision describe error — enhancing without context:", e.message);
    return "";
  }
}

async function handleUpscaleImage(req, res) {
  if (!openaiApiKey) {
    sendJson(res, 503, { error: "OPENAI_API_KEY not set on server." });
    return;
  }

  try {
    // Read raw image body (10 MB cap)
    const MAX_BYTES = 10 * 1024 * 1024;
    const chunks = [];
    let total = 0;
    for await (const chunk of req) {
      total += chunk.length;
      if (total > MAX_BYTES) {
        sendJson(res, 413, { error: "Image exceeds 10 MB." });
        return;
      }
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);
    if (buffer.length < 1000) {
      sendJson(res, 400, { error: "Empty or invalid image body." });
      return;
    }
    const mime = req.headers["content-type"]?.includes("jpeg") ? "image/jpeg" : "image/png";
    const headline = decodeURIComponent(req.headers["x-headline"] || "").trim().slice(0, 200);

    const sizeHint = (req.headers["x-image-orientation"] || "").toString();
    const size =
      sizeHint === "landscape" ? "1536x1024" :
      sizeHint === "portrait"  ? "1024x1536" :
      "auto";

    // Identity preservation beats cost for news photos — default high.
    const quality = (process.env.IMAGE_QUALITY || "high").toLowerCase();

    const t0 = Date.now();

    // Stage 1 — understand the image (cheap, fails soft)
    const description = await describeImageForEnhance(buffer, mime);
    if (description) console.log(`✓ vision context (${Date.now() - t0}ms): ${description.slice(0, 140)}…`);

    // Stage 2 — context-aware enhancement
    const form = new FormData();
    form.append("model", "gpt-image-1");
    form.append("prompt", buildEnhancePrompt(description, headline));
    form.append("size", size);
    form.append("quality", quality);
    form.append("input_fidelity", "high");   // OpenAI's face/identity preservation control
    form.append("image", new Blob([buffer], { type: mime }), mime === "image/jpeg" ? "input.jpg" : "input.png");

    const aiRes = await fetch("https://api.openai.com/v1/images/edits", {
      method: "POST",
      headers: { "Authorization": `Bearer ${openaiApiKey}` },
      body: form,
    });

    if (!aiRes.ok) {
      const errText = await aiRes.text().catch(() => "");
      console.error(`✗ gpt-image-1 ${aiRes.status}:`, errText.slice(0, 400));
      sendJson(res, 502, { error: `OpenAI image ${aiRes.status}`, detail: errText.slice(0, 300) });
      return;
    }

    const data = await aiRes.json();
    const b64 = data?.data?.[0]?.b64_json;
    if (!b64) {
      sendJson(res, 502, { error: "OpenAI returned no image data." });
      return;
    }

    console.log(`✓ AI enhance done in ${Date.now() - t0}ms (quality=${quality})`);
    sendJson(res, 200, { image: `data:image/png;base64,${b64}`, context: description });
  } catch (err) {
    console.error("✗ upscale-image error:", err);
    sendJson(res, 500, { error: err.message || "Image enhance failed." });
  }
}
