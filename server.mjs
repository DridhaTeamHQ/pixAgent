import http from "node:http";
import {
  createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync,
  readFileSync, renameSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { extname, join, normalize } from "node:path";
import { tmpdir } from "node:os";
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { TwitterApi } from "twitter-api-v2";
import Busboy from "busboy";

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

/**
 * Read a secret from the environment, defensively.
 *
 * Pasting into a hosting dashboard very easily carries a trailing newline, a
 * stray space, or the surrounding quotes from a .env line. Any of those goes
 * straight into an Authorization header and the provider answers 401 — which
 * reads as "my key is wrong" when the key is fine. Strip them here so a
 * cosmetic paste error can't masquerade as a bad credential.
 */
function env(name, ...aliases) {
  for (const key of [name, ...aliases]) {
    const raw = process.env[key] ?? secrets[key];
    if (raw == null) continue;
    const cleaned = String(raw).trim().replace(/^(['"])([\s\S]*)\1$/, "$2").trim();
    if (cleaned) return cleaned;
  }
  return "";
}

// Warn loudly if a value needed cleaning — otherwise this silently papers
// over a misconfiguration the user should fix at the source.
for (const name of ["OPENAI_API_KEY", "UPSCALER_SECRET", "SHORTLY_AGENT_AUTH_SECRET", "PEXELS_API_KEY", "FAL_KEY"]) {
  const raw = process.env[name] ?? secrets[name];
  if (raw != null && String(raw) !== env(name)) {
    console.warn(`⚠ ${name} had surrounding whitespace or quotes — trimmed. Fix it in the dashboard.`);
  }
}
const pexelsApiKey = env("PEXELS_API_KEY", "pexelsApiKey");
if (pexelsApiKey) {
  console.log(`✓ Pexels API key loaded (${pexelsApiKey.slice(0, 6)}…)`);
} else {
  console.warn("⚠ No Pexels API key found. Stock images will not work.");
  console.warn("  Checked: .env in project dir and parent dir, or PEXELS_API_KEY env var.");
}

/* ── Twitter / X (OAuth 1.0a) ── */
const twitterCfg = {
  appKey:       env("TWITTER_API_KEY"),
  appSecret:    env("TWITTER_API_SECRET"),
  accessToken:  env("TWITTER_ACCESS_TOKEN"),
  accessSecret: env("TWITTER_ACCESS_SECRET"),
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
const openaiApiKey = env("OPENAI_API_KEY");
if (openaiApiKey) {
  // Log a fingerprint, never the key. Prefix + length + last 4 is enough to
  // tell "the wrong key is deployed" apart from "the key is revoked" without
  // putting a live credential in the logs.
  const shape = `${openaiApiKey.slice(0, 8)}…${openaiApiKey.slice(-4)} len=${openaiApiKey.length}`;
  console.log(`✓ OpenAI API key loaded (${shape})`);
  if (!/^sk-[A-Za-z0-9_-]+$/.test(openaiApiKey)) {
    console.warn("⚠ OPENAI_API_KEY doesn't look like an OpenAI key (expected sk-… with no spaces).");
  }
} else {
  console.warn("⚠ OPENAI_API_KEY missing — AI features will return 503.");
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

  if (req.method === "POST" && req.url === "/api/video/resolve") {
    await handleVideoResolve(req, res);
    return;
  }

  if (req.method === "GET" && req.url?.startsWith("/api/video/preview?")) {
    await handleVideoPreview(req, res);
    return;
  }

  if (req.method === "POST" && req.url === "/api/video/clip") {
    await handleVideoClip(req, res);
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

  // Railway (and any other platform healthcheck) pings this.
  if (req.method === "GET" && (req.url === "/health" || req.url === "/healthz")) {
    sendJson(res, 200, {
      ok: true,
      uptime: Math.round(process.uptime()),
      features: {
        openai: Boolean(env("OPENAI_API_KEY")),
        upscaler: Boolean(env("UPSCALER_URL")),
        // Video works when both binaries are on PATH; cookies are what make
        // YouTube reliable from a datacenter IP.
        ffmpeg: Boolean(ffmpegAvailable),
        ytdlp: Boolean(ytdlpAvailable),
        ytdlpCookies: Boolean(cookieFilePath),
        jsRuntime: Boolean(jsRuntimeAvailable),
        ytdlpProxy: Boolean(ytdlpProxy),
        pexels: Boolean(pexelsApiKey),
      },
    });
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

  // ── Caching ──
  // On Vercel the CDN handled this. Serving directly, we have to: without
  // it every page load re-downloads app.js (~180 KB) and the logos.
  //
  // Assets that carry no content hash (app.js, styles.css, index.html) get
  // `no-cache`, which means "revalidate every time" — NOT "don't store".
  // Combined with Last-Modified the browser sends If-Modified-Since and we
  // answer 304 with an empty body: the bytes are saved, and a deploy can
  // never serve stale code. Images and fonts are immutable in practice and
  // get a real max-age.
  const stat = statSync(filePath);
  const ext = extname(filePath).toLowerCase();
  const lastModified = stat.mtime.toUTCString();

  const ims = req.headers["if-modified-since"];
  if (ims && Date.parse(ims) >= Math.floor(stat.mtimeMs / 1000) * 1000) {
    res.writeHead(304, { "Last-Modified": lastModified });
    res.end();
    return;
  }

  const immutable = [".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg", ".ico", ".woff", ".woff2"];
  const cacheControl = immutable.includes(ext)
    ? "public, max-age=86400"
    : "no-cache";

  res.writeHead(200, {
    "Content-Type": types[ext] || "application/octet-stream",
    "Content-Length": stat.size,
    "Last-Modified": lastModified,
    "Cache-Control": cacheControl,
    "X-Content-Type-Options": "nosniff",
  });
  createReadStream(filePath).pipe(res);
});

server.listen(port, () => {
  console.log(`Pix Post Builder running at http://localhost:${port}`);
});

// Railway sends SIGTERM on redeploy. Without this the process is killed
// outright and in-flight requests (a 5-minute AI enhance, say) die with it.
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    console.log(`${signal} received — finishing in-flight requests…`);
    server.close(() => process.exit(0));
    // Don't hang forever if a client keeps the socket open.
    setTimeout(() => process.exit(0), 15000).unref();
  });
}

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


/* ═══════════════════════ Slide 2 video (yt-dlp + ffmpeg) ═══════════════════════

   Runs in-process rather than as a separate service. The split used to exist
   because Vercel caps serverless request bodies at 4.5 MB, so a 20-200 MB
   video upload could never transit a function — the browser had to POST
   straight to a second host, which needed a shared secret, HMAC tokens and
   CORS. On Railway that cap doesn't exist, so all of that is gone: these are
   ordinary same-origin routes.

   Branding is NOT drawn here. The browser renders the exact overlay it shows
   in the live preview to a transparent PNG and uploads it alongside the clip;
   ffmpeg only composites. That keeps fonts and layout identical to what the
   user approved on screen, and means design changes never touch this file.

   Env:
     YTDLP_COOKIES     base64 Netscape cookies.txt — required for YouTube from
                       a datacenter IP, and for most of Instagram
     MAX_CLIP_SECONDS  output length cap (default 90)
     MAX_UPLOAD_BYTES  local upload cap (default 300 MB)
*/

const MAX_CLIP_SECONDS = Number(process.env.MAX_CLIP_SECONDS || 90);
const MAX_VIDEO_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES || 300 * 1024 * 1024);
const RESOLVE_TIMEOUT_MS = 60_000;
const CLIP_TIMEOUT_MS = 600_000;

// Railway's variable UI is single-line, so the cookies file is passed base64.
// Written once at startup; yt-dlp reads it from disk.
const COOKIE_FILE = join(tmpdir(), "pix-ytdlp-cookies.txt");
const cookieFilePath = (() => {
  const raw = (env("YTDLP_COOKIES")).trim();
  if (!raw) return "";
  try {
    // Accept either base64 or the file pasted verbatim.
    const looksBase64 = /^[A-Za-z0-9+/=\s]+$/.test(raw) && !raw.includes("\t");
    const data = looksBase64 ? Buffer.from(raw, "base64") : Buffer.from(raw, "utf-8");
    if (data.length < 20) return "";
    writeFileSync(COOKIE_FILE, data);
    return COOKIE_FILE;
  } catch {
    return "";
  }
})();

if (cookieFilePath) {
  console.log("✓ yt-dlp cookies loaded");
} else {
  console.warn("⚠ No YTDLP_COOKIES — YouTube may bot-check this server and Instagram will mostly fail.");
}

// Probe the two binaries once at startup so /health can report a misbuilt
// image directly, instead of every export failing with a confusing ENOENT.
let ffmpegAvailable = false;
let ytdlpAvailable = false;
let jsRuntimeAvailable = false;
(async () => {
  const [ff, yt, deno] = await Promise.all([
    run("ffmpeg", ["-version"], 10_000),
    run("yt-dlp", ["--version"], 10_000),
    run("deno", ["--version"], 10_000),
  ]);
  ffmpegAvailable = ff.code === 0;
  ytdlpAvailable = yt.code === 0;
  jsRuntimeAvailable = deno.code === 0;

  if (ffmpegAvailable && ytdlpAvailable) {
    console.log(`✓ Video ready (yt-dlp ${yt.stdout.toString().trim()})`);
  } else {
    if (!ffmpegAvailable) console.warn("⚠ ffmpeg not found — video export will fail.");
    if (!ytdlpAvailable) console.warn("⚠ yt-dlp not found — link fetching will fail.");
  }

  // This combination is a trap, so it gets its own warning.
  //
  // Authenticated YouTube requests are served formats whose URLs must be
  // deciphered by running YouTube's JavaScript. Anonymous requests get
  // simpler ones. So without a JS runtime, adding cookies makes extraction
  // FAIL where it previously worked: measured locally, android_vr resolves
  // fine with no cookies and fails with "Requested format is not available"
  // once cookies are supplied. Cookies and deno are a package deal.
  if (!jsRuntimeAvailable) {
    if (cookieFilePath) {
      console.warn(
        "⚠ YTDLP_COOKIES is set but no JS runtime (deno) was found. Authenticated " +
        "YouTube extraction REQUIRES one — every fetch will fail with \"Requested " +
        "format is not available\". Deploy the current Dockerfile, or unset YTDLP_COOKIES."
      );
    } else {
      console.warn("⚠ No JS runtime (deno) — YouTube extraction is limited and cookies will not work.");
    }
  }
})();

/* ── YouTube client fallback ──
   YouTube bot-checks datacenter IPs, which is what any cloud host is. Which
   "player client" yt-dlp impersonates changes how often that happens, and no
   single one is reliable — so rather than failing on the first block, try a
   ladder. Cookies remain the dependable fix, but this clears a good share of
   requests without them.

   The empty first entry is yt-dlp's own default (currently android_vr-led),
   which is fastest when it works. android_vr and tv_embedded are the two
   clients that need no JS challenge, so they still work even if the deno
   runtime is missing from the image. */
const YOUTUBE_CLIENT_LADDER = ["", "android_vr", "tv_embedded", "web_safari", "mweb"];

/* A proxy is the only thing that actually fixes the root cause. YouTube
   blocks by IP reputation, and every cloud host — Railway included — sits in
   a flagged datacenter range. Cookies work around it by proving there's an
   account behind the request; a residential proxy removes the reason for the
   challenge in the first place, with nothing to expire and no account to
   ban. Accepts any yt-dlp proxy URL:
     http://user:pass@host:port   socks5://user:pass@host:port          */
const ytdlpProxy = env("YTDLP_PROXY");
if (ytdlpProxy) {
  // Never log the proxy URL itself — it usually carries credentials.
  let host = "configured";
  try { host = new URL(ytdlpProxy).host.replace(/^.*@/, ""); } catch { /* keep generic */ }
  console.log(`✓ yt-dlp proxy enabled (${host})`);
}

function ytdlpArgs(extra, client = "") {
  const base = ["--no-playlist", "--no-warnings"];
  if (ytdlpProxy) base.push("--proxy", ytdlpProxy);
  if (cookieFilePath) base.push("--cookies", cookieFilePath);
  if (client) base.push("--extractor-args", `youtube:player_client=${client}`);
  return base.concat(extra);
}

// Only bot-checks and format-availability failures are worth another client;
// a private or deleted video will fail identically every time, and retrying
// just burns a minute.
function worthRetryingWithAnotherClient(stderr) {
  const low = String(stderr || "").toLowerCase();
  return low.includes("sign in to confirm")
      || low.includes("not a bot")
      || low.includes("requested format is not available")
      || low.includes("failed to extract")
      || low.includes("unable to extract")
      || low.includes("http error 403")
      || low.includes("http error 429");
}

/**
 * Run yt-dlp, walking the client ladder while the failure looks like a
 * block rather than a genuinely missing video. Non-YouTube URLs get one
 * attempt — the player_client arg means nothing to other extractors.
 */
async function runYtdlp(extra, timeoutMs) {
  const isYouTube = /(?:youtube\.com|youtu\.be)/i.test(extra.join(" "));
  const ladder = isYouTube ? YOUTUBE_CLIENT_LADDER : [""];
  let last = null;

  for (const client of ladder) {
    const r = await run("yt-dlp", ytdlpArgs(extra, client), timeoutMs);
    if (r.code === 0) {
      if (client) console.log(`✓ yt-dlp succeeded with player_client=${client}`);
      return r;
    }
    last = r;
    if (r.timedOut) break;
    if (!worthRetryingWithAnotherClient(r.stderr || r.stdout)) break;
    if (client !== ladder[ladder.length - 1]) {
      console.warn(`⚠ yt-dlp blocked on client "${client || "default"}" — trying the next one`);
    }
  }
  return last;
}

// Spawn a binary, capture stdout/stderr, enforce a wall-clock timeout.
function run(bin, args, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, { windowsHide: true });
    } catch (err) {
      resolve({ code: -1, stdout: Buffer.alloc(0), stderr: Buffer.from(String(err.message)) });
      return;
    }
    const out = [];
    const err = [];
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);

    child.stdout.on("data", (d) => out.push(d));
    child.stderr.on("data", (d) => err.push(d));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout: Buffer.concat(out), stderr: Buffer.from(String(e.message)) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, timedOut, stdout: Buffer.concat(out), stderr: Buffer.concat(err) });
    });
  });
}

// yt-dlp's stderr is a wall of text; turn the known failures into something
// the user can actually act on.
function friendlyYtdlpError(stderr) {
  const text = String(stderr || "");
  const low = text.toLowerCase();
  if (low.includes("sign in to confirm") || low.includes("not a bot")) {
    return "YouTube blocked this server as automated — cloud IPs are flagged by default. " +
           "Fix it with YTDLP_COOKIES (cookies from a throwaway logged-in account) or " +
           "YTDLP_PROXY (a residential proxy). Uploading a file works either way.";
  }
  if (low.includes("login required") || low.includes("requested content is not available")) {
    return "This content requires a login. Set YTDLP_COOKIES with cookies from an account that can view it.";
  }
  if (low.includes("private video")) return "That video is private.";
  if (low.includes("video unavailable") || low.includes("removed")) return "That video is unavailable or has been removed.";
  if (low.includes("unsupported url")) return "That link isn't a supported video URL.";
  if (low.includes("rate-limit") || low.includes("429")) return "The source is rate-limiting this server. Try again in a few minutes.";
  if (low.includes("enoent")) return "yt-dlp is not installed on this server.";
  const lines = text.trim().split("\n").filter(Boolean);
  return (lines[lines.length - 1] || "Download failed.").slice(0, 300);
}

async function handleVideoResolve(req, res) {
  try {
    const body = await readJson(req);
    const url = String(body.url || "").trim();
    if (!/^https?:\/\//i.test(url)) {
      sendJson(res, 400, { error: "A http(s) URL is required." });
      return;
    }

    const r = await runYtdlp(["--dump-single-json", "--skip-download", url], RESOLVE_TIMEOUT_MS);
    if (r.timedOut) { sendJson(res, 504, { error: "Resolving the video timed out." }); return; }
    if (r.code !== 0) { sendJson(res, 502, { error: friendlyYtdlpError(r.stderr || r.stdout) }); return; }

    let info;
    try {
      info = JSON.parse(r.stdout.toString("utf-8"));
    } catch {
      sendJson(res, 502, { error: "Could not parse video metadata." });
      return;
    }

    sendJson(res, 200, {
      title: info.title || "",
      duration: info.duration || 0,
      thumbnail: info.thumbnail || "",
      uploader: info.uploader || info.channel || "",
      extractor: info.extractor_key || "",
      width: info.width || 0,
      height: info.height || 0,
      webpage_url: info.webpage_url || url,
    });
  } catch (error) {
    sendJson(res, 500, { error: error.message || "Resolve failed." });
  }
}


/* ── Scrubbable preview for linked videos ──
   A browser can't play a YouTube/Instagram *page* URL, so a linked video
   used to show only a poster: you picked trim points blind, against a video
   you couldn't watch. That makes trimming guesswork.

   So the server fetches a small copy and streams it back same-origin. Kept
   deliberately low-res — this exists to be scrubbed, not to be the output;
   the export still downloads full quality separately.

   Direct CDN URLs aren't an option: YouTube's googlevideo links are bound to
   the IP that requested them (ours, not the viewer's) and Instagram's are
   CORS-restricted. Proxying is what makes it play at all. */

// Preview doubles as the export source (see handleVideoClip), so this is a
// real quality knob, not just scrubbing resolution. 720 upscales acceptably
// to the 1080-wide output and downloads far faster than 4K.
const PREVIEW_HEIGHT = Number(process.env.VIDEO_QUALITY || 720);
const PREVIEW_DIR = join(tmpdir(), "pix-preview");
const PREVIEW_TTL_MS = 60 * 60 * 1000;          // 1 hour
const PREVIEW_MAX_BYTES = 120 * 1024 * 1024;
mkdirSync(PREVIEW_DIR, { recursive: true });

// One in-flight download per URL — a <video> element will happily fire
// several overlapping range requests the moment it gets a src.
const previewInFlight = new Map();

function previewPathFor(url) {
  const key = createHash("sha1").update(url).digest("hex").slice(0, 20);
  return join(PREVIEW_DIR, `${key}.mp4`);
}

// Evict old previews so /tmp doesn't grow without bound.
function sweepPreviewCache() {
  try {
    for (const name of readdirSync(PREVIEW_DIR)) {
      const p = join(PREVIEW_DIR, name);
      try {
        if (Date.now() - statSync(p).mtimeMs > PREVIEW_TTL_MS) rmSync(p, { force: true });
      } catch { /* raced with another sweep */ }
    }
  } catch { /* dir vanished */ }
}
setInterval(sweepPreviewCache, 15 * 60 * 1000).unref();

async function ensurePreviewFile(url) {
  const dest = previewPathFor(url);
  if (existsSync(dest) && statSync(dest).size > 1000) return dest;
  if (previewInFlight.has(dest)) return previewInFlight.get(dest);

  const job = (async () => {
    // The temp name MUST end in .mp4. yt-dlp derives the merge container
    // from the output extension, so a ".part" suffix makes a DASH merge
    // write its result elsewhere and the existence check below fails —
    // which looked exactly like a download failure while progressive
    // (single-file) downloads kept working.
    const tmp = dest.replace(/\.mp4$/, ".downloading.mp4");
    const r = await runYtdlp([
      // Order matters: YouTube's progressive (single-file) streams top out at
      // 360p, so asking for "best single file" quietly gets you 360p. Prefer
      // the DASH video+audio pair, which is where 720p actually lives, and
      // fall back to progressive only if the merge isn't possible.
      "-f", `bv*[ext=mp4][height<=${PREVIEW_HEIGHT}]+ba[ext=m4a]/bv*[height<=${PREVIEW_HEIGHT}]+ba/b[ext=mp4][height<=${PREVIEW_HEIGHT}]/b[ext=mp4]/b`,
      "--merge-output-format", "mp4",
      "-o", tmp,
      url,
    ], 180_000);
    if (r.code !== 0 || !existsSync(tmp)) {
      try { rmSync(tmp, { force: true }); } catch {}
      throw new Error(friendlyYtdlpError(r.stderr || r.stdout));
    }
    if (statSync(tmp).size > PREVIEW_MAX_BYTES) {
      rmSync(tmp, { force: true });
      throw new Error("Preview copy is too large.");
    }
    renameSync(tmp, dest);
    return dest;
  })().finally(() => previewInFlight.delete(dest));

  previewInFlight.set(dest, job);
  return job;
}

/**
 * GET /api/video/preview?u=<encoded page url>
 * Streams the cached preview copy, honouring Range so the <video> element
 * can seek. Without range support scrubbing doesn't work at all in Safari.
 */
async function handleVideoPreview(req, res) {
  try {
    const requestUrl = new URL(req.url, `http://localhost:${port}`);
    const target = (requestUrl.searchParams.get("u") || "").trim();
    if (!/^https?:\/\//i.test(target)) {
      sendJson(res, 400, { error: "A http(s) URL is required." });
      return;
    }

    let file;
    try {
      file = await ensurePreviewFile(target);
    } catch (err) {
      sendJson(res, 502, { error: err.message || "Could not build a preview." });
      return;
    }

    const size = statSync(file).size;
    const range = req.headers.range;

    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      let start = m && m[1] ? parseInt(m[1], 10) : 0;
      let end = m && m[2] ? parseInt(m[2], 10) : size - 1;
      if (!Number.isFinite(start) || start < 0) start = 0;
      if (!Number.isFinite(end) || end >= size) end = size - 1;
      if (start > end) {
        res.writeHead(416, { "Content-Range": `bytes */${size}` });
        res.end();
        return;
      }
      res.writeHead(206, {
        "Content-Type": "video/mp4",
        "Content-Length": end - start + 1,
        "Content-Range": `bytes ${start}-${end}/${size}`,
        "Accept-Ranges": "bytes",
        "Cache-Control": "private, max-age=3600",
      });
      createReadStream(file, { start, end }).pipe(res);
      return;
    }

    res.writeHead(200, {
      "Content-Type": "video/mp4",
      "Content-Length": size,
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, max-age=3600",
    });
    createReadStream(file).pipe(res);
  } catch (error) {
    if (!res.headersSent) sendJson(res, 500, { error: error.message || "Preview failed." });
  }
}

// Stream a multipart body to disk. Buffering a 300 MB upload in memory would
// put the whole container at risk, so files go straight to /tmp and only the
// small text fields are kept in memory.
function receiveClipUpload(req, dir) {
  return new Promise((resolve, reject) => {
    const fields = {};
    const files = {};
    const pending = [];
    let aborted = null;

    let bb;
    try {
      bb = Busboy({ headers: req.headers, limits: { files: 2, fileSize: MAX_VIDEO_UPLOAD_BYTES } });
    } catch (err) {
      reject(new Error("Malformed upload: " + err.message));
      return;
    }

    bb.on("field", (name, value) => { fields[name] = value; });

    bb.on("file", (name, stream, info) => {
      if (name !== "video" && name !== "overlay") { stream.resume(); return; }
      const dest = join(dir, name === "video" ? "source.bin" : "overlay.png");
      files[name] = { path: dest, name: info.filename || "", bytes: 0 };
      const ws = createWriteStream(dest);
      const done = new Promise((res2, rej2) => {
        stream.on("data", (d) => { files[name].bytes += d.length; });
        stream.on("limit", () => { aborted = `${name} exceeds the ${Math.round(MAX_VIDEO_UPLOAD_BYTES / 1048576)} MB limit`; });
        ws.on("finish", res2);
        ws.on("error", rej2);
      });
      pending.push(done);
      stream.pipe(ws);
    });

    bb.on("error", reject);
    bb.on("close", async () => {
      try {
        await Promise.all(pending);
        if (aborted) { reject(new Error(aborted)); return; }
        resolve({ fields, files });
      } catch (err) { reject(err); }
    });

    req.pipe(bb);
  });
}

async function handleVideoClip(req, res) {
  const job = randomUUID().replace(/-/g, "");
  const dir = join(tmpdir(), `pix-clip-${job}`);
  mkdirSync(dir, { recursive: true });
  const outPath = join(dir, "out.mp4");

  try {
    const { fields, files } = await receiveClipUpload(req, dir);

    const start = Number(fields.start || 0);
    const end = Number(fields.end || 0);
    const width = Math.trunc(Number(fields.width || 1080));
    const height = Math.trunc(Number(fields.height || 1920));
    const mute = String(fields.mute || "") === "true";
    const url = String(fields.url || "").trim();

    const duration = Math.round((end - start) * 1000) / 1000;
    if (!Number.isFinite(duration) || duration <= 0) {
      sendJson(res, 400, { error: "End must be after start." });
      return;
    }
    if (duration > MAX_CLIP_SECONDS) {
      sendJson(res, 400, { error: `Clip is ${duration.toFixed(0)}s; the limit is ${MAX_CLIP_SECONDS}s.` });
      return;
    }
    if (!(width > 0 && height > 0) || width % 2 || height % 2) {
      sendJson(res, 400, { error: "Width and height must be positive even numbers." });
      return;
    }
    if (!url && !files.video) {
      sendJson(res, 400, { error: "Supply either a url or a video file." });
      return;
    }

    // Source: local upload, or fetch with yt-dlp.
    let srcPath;
    if (files.video) {
      if (files.video.bytes < 1000) { sendJson(res, 400, { error: "Empty or invalid video file." }); return; }
      srcPath = files.video.path;
    } else {
      // Scrubbing already pulled this exact video down. Re-downloading it
      // wastes a minute and — because two fetches of the same media in quick
      // succession look like scraping — reliably earns an HTTP 403 from
      // YouTube. Reuse the cached copy when it's there.
      const cached = previewPathFor(url);
      if (existsSync(cached) && statSync(cached).size > 1000) {
        srcPath = cached;
        console.log("✓ clip reusing the cached preview download");
      } else {
        srcPath = join(dir, "source.mp4");
        const dl = await runYtdlp([
          "-f", `bv*[ext=mp4][height<=${PREVIEW_HEIGHT}]+ba[ext=m4a]/b[ext=mp4][height<=${PREVIEW_HEIGHT}]/b[ext=mp4]/b`,
          "--merge-output-format", "mp4",
          "-o", srcPath,
          url,
        ], CLIP_TIMEOUT_MS);
        if (dl.timedOut) { sendJson(res, 504, { error: "Downloading the video timed out." }); return; }
        if (dl.code !== 0 || !existsSync(srcPath)) {
          sendJson(res, 502, { error: friendlyYtdlpError(dl.stderr || dl.stdout) });
          return;
        }
      }
    }

    // Scale-to-cover + centre-crop to the target frame, then composite the
    // overlay. `-ss` before `-i` seeks fast; accuracy still holds because we
    // re-encode. `0:a?` makes audio optional so silent sources don't fail.
    const cover = `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1`;
    const args = ["-hide_banner", "-loglevel", "error", "-y", "-ss", String(start), "-i", srcPath];
    let filter;
    if (files.overlay && files.overlay.bytes > 0) {
      args.push("-i", files.overlay.path);
      filter = `[0:v]${cover}[bg];[1:v]scale=${width}:${height}[ov];[bg][ov]overlay=0:0[v]`;
    } else {
      filter = `[0:v]${cover}[v]`;
    }
    args.push("-t", String(duration), "-filter_complex", filter, "-map", "[v]");
    if (mute) args.push("-an");
    else args.push("-map", "0:a?", "-c:a", "aac", "-b:a", "128k");
    args.push(
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", "20",
      "-pix_fmt", "yuv420p",      // required for Safari / iOS playback
      "-movflags", "+faststart",  // metadata up front so it streams
      outPath,
    );

    const enc = await run("ffmpeg", args, CLIP_TIMEOUT_MS);
    if (enc.timedOut) { sendJson(res, 504, { error: "Encoding timed out." }); return; }
    if (enc.code !== 0) {
      const tail = enc.stderr.toString("utf-8").slice(-300);
      const msg = /enoent/i.test(tail) ? "ffmpeg is not installed on this server." : `Encoding failed: ${tail}`;
      sendJson(res, 500, { error: msg });
      return;
    }

    const stat = statSync(outPath);
    if (stat.size < 1000) { sendJson(res, 500, { error: "The encoder produced an empty file." }); return; }

    res.writeHead(200, {
      "Content-Type": "video/mp4",
      "Content-Length": stat.size,
      "X-Clip-Duration": String(duration),
      "Content-Disposition": 'attachment; filename="clip.mp4"',
    });
    createReadStream(outPath).pipe(res);
    res.on("close", () => rmSync(dir, { recursive: true, force: true }));
    return;   // cleanup happens on stream close, not in finally
  } catch (error) {
    if (!res.headersSent) sendJson(res, 500, { error: error.message || "Clip failed." });
  }
  rmSync(dir, { recursive: true, force: true });
}

async function handleAgentSession(req, res) {
  try {
    const secret = env("SHORTLY_AGENT_AUTH_SECRET");
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
    const falKey = env("FAL_KEY", "falKey");
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
    const apiKey = env("OPENAI_API_KEY");
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

/**
 * Turn an OpenAI error body into something the user can act on.
 *
 * "OpenAI 401" on its own is useless — it doesn't distinguish a revoked key
 * from a malformed header from a key belonging to the wrong project. OpenAI
 * says which in the response body; surface it.
 */
function openaiErrorMessage(status, body) {
  let detail = "";
  try {
    detail = JSON.parse(body)?.error?.message || "";
  } catch {
    detail = String(body || "").slice(0, 200);
  }
  const low = detail.toLowerCase();

  if (status === 401) {
    if (low.includes("incorrect api key")) {
      return "OpenAI rejected this key as invalid. It was most likely revoked or regenerated — " +
             "create a fresh one at platform.openai.com/api-keys and update OPENAI_API_KEY.";
    }
    if (low.includes("no api key") || low.includes("provide an api key")) {
      return "OpenAI received no key. OPENAI_API_KEY is set but empty or malformed — " +
             "check for quotes or line breaks in the value.";
    }
    return `OpenAI rejected the key (401). ${detail}`.trim();
  }
  if (status === 429) {
    return low.includes("quota")
      ? "OpenAI quota exhausted — add credit at platform.openai.com/settings/organization/billing."
      : "OpenAI is rate-limiting this key. Wait a moment and retry.";
  }
  if (status === 403) {
    return `OpenAI denied access (403). The key may lack permission for this model. ${detail}`.trim();
  }
  if (status >= 500) return "OpenAI is having problems (5xx). Try again shortly.";
  return `OpenAI ${status}. ${detail}`.trim();
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
      res.end(JSON.stringify({ error: openaiErrorMessage(aiRes.status, errText) }));
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

/* ── OpenAI — full article package (headline + 3 bullets + tweet) ──
   Local-dev mirror of api/generate-article.js. Editorial rules live in the
   shared prompt below; keep both copies in sync when editing. */
const EDITORIAL_SYSTEM_PROMPT = [
  "You are a journalist and content writer for Shortly (@SHORTLY__NEWS), a Twitter/X-style news app. Given a source headline and, when available, the article text, produce a news package in STRICT JSON with this exact shape:",
  "",
  '{ "headline": string, "bullets": [string, string, string], "tweet": string, "flags": [string] }',
  "",
  "SLIDE 1 — the \"headline\" field:",
  "- Maximum 55 characters.",
  "- Use VERY SIMPLE, plain, conversational everyday English — the way you would casually tell a friend what happened. Short common words, no jargon, no formal or complex vocabulary.",
  "- Not punchy, not sensational, not clickbaity, but it should make the reader curious.",
  "- Clearly and specifically summarise what the story is about. Be specific — name which World Cup, which year, which city, who the person is.",
  "- Avoid vague phrasing like 'boosts sentiment' or 'makes waves'.",
  "- Correct sentence capitalisation. No periods between initials (write MS Dhoni, PM, US, UK — never M.S. Dhoni).",
  "- Never reuse the headline's exact phrasing in the bullets.",
  "",
  "SLIDE 2 — the \"bullets\" field: EXACTLY 3 bullet points (a context card).",
  "- Each bullet is NO MORE THAN 80 characters including spaces (aim for 65 to 80). NEVER exceed 80 characters.",
  "- The three bullets flow naturally and build on each other, in this order: (1) context or background, (2) what happened, (3) another point of view or a value-add.",
  "- Each bullet is ONE complete sentence — never cut off midway, never trailing off.",
  "- No em dashes; let sentences flow naturally. No periods between initials (MS Dhoni not M.S. Dhoni).",
  "- Only use a direct quote when quoting verbatim, immediately followed by the person's name; otherwise rephrase in third person.",
  "- Strictly sourced from the provided material — no extrapolation or outside knowledge.",
  "- Neutral, professional, British English. Clear, natural language that is both conversational and formal, with no conversational filler.",
  "",
  "TWEET — the \"tweet\" field. Build it in three parts separated by newlines:",
  "- Part 1: one or two short sentences, maximum 200 characters including the call to action. Professional but Gen Z-friendly tone. Neutral — no political lean, no editorialising. No em dashes.",
  "- Part 2 (new line), exactly: Follow @SHORTLY__NEWS for more 👇",
  "- Part 3 (new line): relevant @handles and #hashtags, ALL in lowercase (e.g. @bcci @icc #indvsaus #t20worldcup). 3 to 6 tags, most specific first, no generic filler like #news or #trending.",
  "",
  "PEOPLE IDENTIFICATION:",
  "- On first mention of a person, add a brief identifier — their role, title or what they are known for (e.g. 'Sunil Mittal, chairman of Bharti Enterprises', not just 'Sunil Mittal'). Never assume the audience knows the name.",
  "",
  "EDITORIAL RULES:",
  "- Use ONLY the provided material. Never fabricate statistics, records or quotes, and never add outside knowledge.",
  "- If a headline claim is not supported by the article text, if the story is communal, religious, politically sensitive or otherwise unverified, or if it reads as older than yesterday, add a short note to flags. flags is an empty array when there is nothing to raise.",
  "- Both sides represented on political or contested stories — no one-sided framing.",
  "- Do not present promotional or sponsored content as news.",
  "- Safe reporting for deaths, suicide and tragedy: no method details, no sensationalising, neutral tone.",
  "",
  "EXAMPLE bullets (3, each a complete sentence, max 80 chars, context then what-happened then value-add):",
  '- "Amitabh Bachchan, a top Bollywood actor, has been buying more property lately."',
  '- "Developer Abhinandan Lodha says Bachchan paid Rs 15 crore for a plot in a day."',
  '- "The quick deal shows more stars are eyeing Ayodhya\'s fast-growing land market."',
  "",
  "Output ONLY the JSON object. No prose around it.",
].join("\n");

// Spec: every @handle/#hashtag after the CTA line is lowercase. The model
// occasionally keeps official casing (@RBI) — enforce deterministically.
function lowercaseTagLines(tweet) {
  const lines = String(tweet).split("\n");
  const ctaIdx = lines.findIndex((l) => /follow\s+@shortly__news/i.test(l));
  if (ctaIdx >= 0) {
    for (let i = ctaIdx + 1; i < lines.length; i++) lines[i] = lines[i].toLowerCase();
  }
  return lines.join("\n");
}

// Keep the tweet ≤280 chars, trimming at whitespace so a trailing hashtag
// is never cut mid-word.
function clampTweet(s) {
  s = lowercaseTagLines(String(s).replace(/[ \t]+\n/g, "\n").trim());
  if (s.length <= 280) return s;
  let cut = s.slice(0, 280);
  const boundary = Math.max(cut.lastIndexOf(" "), cut.lastIndexOf("\n"));
  if (boundary > 240) cut = cut.slice(0, boundary);
  return cut.trim();
}

// A bullet is "good" when it's a complete sentence in the target band.
function bulletIsValid(b) {
  const t = String(b).trim();
  // Target 80-90; allow a little slack, but flag real overflows/fragments.
  if (t.length < 50 || t.length > 84) return false;
  if (!/[.!?]["')\]]?$/.test(t)) return false;
  const core = t.replace(/[.!?"')\]]+$/, "").trim();
  return !TRAILING_STOPWORDS.test(core);
}

// Self-repair pass: rewrite overflowing/fragment bullets into complete
// in-range sentences via gpt-4o-mini. Returns 4 strings or null.
async function repairBullets(headline, articleText, bullets) {
  const prompt =
    "Rewrite these 3 news bullet points so EACH one is a single complete sentence that ends with a full stop and is between 65 and 80 characters long including spaces (never over 80). Keep the same facts and meaning; add no new facts; do not let any sentence trail off. Return STRICT JSON: { \"bullets\": [3 strings] }.\n\n" +
    (headline ? `Headline: ${headline}\n` : "") +
    (articleText ? `Article: ${articleText.slice(0, 500)}\n` : "") +
    "Bullets to fix:\n" + bullets.map((b, i) => `${i + 1}. ${b}`).join("\n");
  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${openaiApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        response_format: { type: "json_object" },
        messages: [{ role: "user", content: prompt }],
        temperature: 0.3,
        max_tokens: 400,
      }),
    });
    if (!r.ok) return null;
    const data = await r.json();
    const parsed = JSON.parse(data?.choices?.[0]?.message?.content || "{}");
    const b = Array.isArray(parsed.bullets) ? parsed.bullets.slice(0, 3).map((x) => String(x).replace(/\s+/g, " ").trim()) : null;
    return b && b.length === 3 && b.every(Boolean) ? b : null;
  } catch {
    return null;
  }
}

// Keep a bullet ≤105 chars WITHOUT ever cutting mid-sentence or mid-word.
// Tiny headroom (110) leaves near-target complete sentences intact; beyond
// that, prefer the longest run of whole sentences that fits, else trim at a
// word boundary and close with a full stop so it never looks chopped.
const TRAILING_STOPWORDS = /\s+(and|or|but|to|of|in|on|at|for|with|the|a|an|its|his|her|their|our|your|this|that|these|those|as|by|from|into|onto|over|under|about|after|before|while|amid|is|are|was|were|has|have|had|will|would|which|who|when|where)$/i;

function clampBullet(s) {
  s = String(s).replace(/\s+/g, " ").trim();
  if (s.length <= 84) return s;

  const MASK = String.fromCharCode(0xE000);
  const masked = s.replace(/(\d)\.(\d)/g, `$1${MASK}$2`);
  const sentences = masked.match(/[^.!?]+[.!?]+/g) || [];
  let acc = "";
  for (const sen of sentences) {
    if ((acc + sen).trim().length <= 82) acc += sen; else break;
  }
  acc = acc.split(MASK).join(".").trim();
  if (acc.length >= 55) return acc;

  let cut = s.slice(0, 78);
  const sp = cut.lastIndexOf(" ");
  if (sp > 45) cut = cut.slice(0, sp);
  cut = cut.replace(/[\s,;:.\-–—]+$/, "").trim();
  while (TRAILING_STOPWORDS.test(cut)) cut = cut.replace(TRAILING_STOPWORDS, "").trim();
  cut = cut.replace(/[\s,;:.\-–—]+$/, "").trim();
  return cut ? cut + "." : cut;
}

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
      sendJson(res, 502, { error: openaiErrorMessage(aiRes.status, errText) });
      return;
    }

    const data = await aiRes.json();
    let parsed = {};
    try { parsed = JSON.parse(data?.choices?.[0]?.message?.content || "{}"); } catch { /* handled below */ }

    const out = {
      headline: (parsed.headline || "").slice(0, 80),
      // Raw-normalize only (no clamp yet) so the repair pass sees full text.
      bullets: Array.isArray(parsed.bullets)
        ? parsed.bullets.slice(0, 3).map((x) => String(x).replace(/\s+/g, " ").trim())
        : [],
      tweet: clampTweet(parsed.tweet || ""),
      flags: Array.isArray(parsed.flags) ? parsed.flags.map(String) : [],
    };
    if (!out.headline || out.bullets.length < 3 || !out.tweet) {
      sendJson(res, 502, { error: "AI returned an incomplete package.", raw: parsed });
      return;
    }

    // Self-repair any bullet that overflows or reads as a fragment, then clamp.
    if (out.bullets.some((b) => !bulletIsValid(b))) {
      const repaired = await repairBullets(headline, articleText, out.bullets);
      if (repaired) {
        console.log("✓ bullets self-repaired");
        out.bullets = repaired;
      }
    }
    out.bullets = out.bullets.map(clampBullet);

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

// This description is embedded in the image-generation prompt, so anything
// it quotes is at risk of being RENDERED into the photo. It therefore
// describes where text sits without reproducing the words — enough for the
// model to know a sign is there and leave it alone, without handing it a
// string to draw.
const VISION_PROMPT =
  "You are assisting a photo-restoration pipeline for a news organisation. " +
  "Describe this photograph in 2-4 sentences, factually and precisely: the people " +
  "(count, apparent age, facial hair, glasses, expressions, clothing), the setting, " +
  "and the lighting. If text, logos or signage appear, say only WHERE they are and " +
  "how large (for example 'a sponsor banner across the back wall') — do NOT transcribe " +
  "or quote the words themselves. " +
  "Do NOT guess names. Output only the description.";

// The headline is deliberately NOT given to the image model.
//
// Image models treat a quoted string in the prompt as text to RENDER, so
// `It accompanies this news story: "<headline>"` reliably produced photos
// with the headline burned into them. The renderer already draws the
// headline on the canvas — the model never needs to know it.
function buildEnhancePrompt(description, _headlineNotUsed, ratioLabel) {
  return [
    "Professional photo restoration of a REAL news photograph.",
    description ? `CONTEXT — the photo shows: ${description}` : "",
    "",
    "TASK: upscale and enhance — recover fine detail, increase sharpness,",
    "remove compression artifacts and noise, correct exposure and colour balance.",
    ratioLabel
      ? `The output canvas is ${ratioLabel}. If the original photo has a different shape, EXTEND the scene naturally (continue the background/setting) to fill the ${ratioLabel} frame — keep the main subject fully visible, at the same relative scale, never cropped, stretched or distorted.`
      : "",
    "",
    "ABSOLUTE RULES:",
    "- Every person's face must stay PIXEL-FAITHFUL to the original identity:",
    "  same facial structure, skin texture, wrinkles, expression and age.",
    "  Do NOT beautify, smooth skin, or idealise anyone.",
    "- DO NOT ADD ANY TEXT OR GRAPHICS. No headline, caption, title, label,",
    "  subtitle, watermark, banner, lower-third or logo. Write no words",
    "  anywhere in the image.",
    "- Text physically present in the photograph (signage, jerseys, banners",
    "  held by people) is preserved exactly as it already appears — never",
    "  invented, completed, translated or extended.",
    "- The original content itself is unchanged — only the surrounding scene",
    "  may be extended to fill the frame. Add no new people or objects of",
    "  interest. This is journalism, not art.",
    "",
    "The result is a clean photograph with no added lettering or graphics.",
  ].filter(Boolean).join("\n");
}

// Map the poster's aspect ratio to the closest gpt-image output size.
function sizeForRatio(ratio, orientationHint) {
  switch (ratio) {
    case "9:16":
    case "4:5":  return "1024x1536";
    case "1:1":  return "1024x1024";
    case "16:9": return "1536x1024";
  }
  if (orientationHint === "landscape") return "1536x1024";
  if (orientationHint === "portrait")  return "1024x1536";
  return "auto";
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

// Primary engine: the self-hosted CodeFormer + Real-ESRGAN service on Railway
// (pixel-faithful, never regenerates faces). Returns a PNG data URL, or null
// if the service isn't configured / errors / times out — caller then falls
// back to gpt-image-1.5.
async function tryRailwayUpscale(buffer, mime) {
  const base = (env("UPSCALER_URL")).replace(/\/+$/, "");
  if (!base) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 285000);
  try {
    const r = await fetch(`${base}/enhance`, {
      method: "POST",
      headers: {
        "Content-Type": mime,
        "X-Secret": env("UPSCALER_SECRET"),
      },
      body: buffer,
      signal: ctrl.signal,
    });
    if (!r.ok) {
      console.warn(`⚠ Railway upscaler ${r.status} — falling back to gpt-image`);
      return null;
    }
    const out = Buffer.from(await r.arrayBuffer());
    if (out.length < 1000) return null;
    return {
      dataUrl: `data:image/png;base64,${out.toString("base64")}`,
      engine: r.headers.get("x-engine") || "railway",
    };
  } catch (e) {
    console.warn("⚠ Railway upscaler unreachable — falling back to gpt-image:", e.message);
    return null;
  } finally {
    clearTimeout(timer);
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

    // PRIMARY: self-hosted upscaler on Railway (pixel-faithful).
    const railwayT0 = Date.now();
    const railway = await tryRailwayUpscale(buffer, mime);
    if (railway) {
      console.log(`✓ AI enhance via Railway (${railway.engine}) in ${Date.now() - railwayT0}ms`);
      sendJson(res, 200, { image: railway.dataUrl, engine: railway.engine });
      return;
    }
    // else fall through to gpt-image-1.5 ↓

    // The SELECTED POSTER RATIO drives the output size, so a 9:16 poster
    // gets a portrait image (outpainted if the source is landscape) instead
    // of a landscape image that the canvas then crops to shreds.
    const posterRatio = (req.headers["x-poster-ratio"] || "").toString();
    const sizeHint = (req.headers["x-image-orientation"] || "").toString();
    const size = sizeForRatio(posterRatio, sizeHint);

    // Default medium: input_fidelity=high (kept) does the face preservation;
    // quality mostly buys texture. high≈$0.25, medium≈$0.06, low≈$0.016.
    const quality = (process.env.IMAGE_QUALITY || "medium").toLowerCase();

    const t0 = Date.now();

    // Stage 1 — understand the image (cheap, fails soft)
    const description = await describeImageForEnhance(buffer, mime);
    if (description) console.log(`✓ vision context (${Date.now() - t0}ms): ${description.slice(0, 140)}…`);

    // Stage 2 — context-aware enhancement.
    // gpt-image-1.5 first; automatic fallback to gpt-image-1 if the account
    // doesn't have the newer model.
    const prompt = buildEnhancePrompt(description, headline, posterRatio);
    const callEdit = async (model) => {
      const form = new FormData();
      form.append("model", model);
      form.append("prompt", prompt);
      form.append("size", size);
      form.append("quality", quality);
      form.append("input_fidelity", "high");   // OpenAI's face/identity preservation control
      form.append("image", new Blob([buffer], { type: mime }), mime === "image/jpeg" ? "input.jpg" : "input.png");
      return fetch("https://api.openai.com/v1/images/edits", {
        method: "POST",
        headers: { "Authorization": `Bearer ${openaiApiKey}` },
        body: form,
      });
    };

    let modelUsed = "gpt-image-1.5";
    let aiRes = await callEdit(modelUsed);
    if (!aiRes.ok && [400, 403, 404].includes(aiRes.status)) {
      const firstErr = await aiRes.text().catch(() => "");
      console.warn(`⚠ gpt-image-1.5 unavailable (${aiRes.status}) — falling back to gpt-image-1:`, firstErr.slice(0, 160));
      modelUsed = "gpt-image-1";
      aiRes = await callEdit(modelUsed);
    }

    if (!aiRes.ok) {
      const errText = await aiRes.text().catch(() => "");
      console.error(`✗ ${modelUsed} ${aiRes.status}:`, errText.slice(0, 400));
      sendJson(res, 502, { error: `OpenAI image ${aiRes.status}`, detail: errText.slice(0, 300) });
      return;
    }

    const data = await aiRes.json();
    const b64 = data?.data?.[0]?.b64_json;
    if (!b64) {
      sendJson(res, 502, { error: "OpenAI returned no image data." });
      return;
    }

    console.log(`✓ AI enhance done in ${Date.now() - t0}ms (${modelUsed}, ${size}, quality=${quality})`);
    sendJson(res, 200, { image: `data:image/png;base64,${b64}`, context: description, engine: modelUsed });
  } catch (err) {
    console.error("✗ upscale-image error:", err);
    sendJson(res, 500, { error: err.message || "Image enhance failed." });
  }
}
