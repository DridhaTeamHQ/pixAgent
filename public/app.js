/* ── Pix Post Builder — Scrape + Edit ── */

const canvas = document.getElementById("post-canvas");
// `ctx` is `let` (not const) so renderToHighResCanvas() can temporarily swap
// it to an offscreen 2× context for export, without rewriting every draw
// function to take a ctx parameter.
let ctx = canvas.getContext("2d");
const screenCtx = ctx;   // permanent reference to the on-screen context

// ── Export resolution ──
// Downloads aim as high as the browser can actually encode: 8K long edge
// first, stepping down to 6K then 4K. Oversized canvases silently fail on
// iOS/low-end GPUs (toBlob returns null or a blank) — the fallback chain in
// renderExportBlob() keeps trying smaller until one really encodes.
//   8K target (7680 long edge):
//     9:16  920×1700  → ×4.52 → 4159×7680
//     4:5  1080×1350  → ×5.69 → 6144×7680
//     1:1  1080×1080  → ×7.11 → 7680×7680
//     16:9 1920×1080  → ×4.00 → 7680×4320 (8K UHD)
const EXPORT_LONG_EDGES = [7680, 6144, 3840];   // 8K → 6K → 4K
function scaleForLongEdge(target) {
  const longEdge = Math.max(canvas.width, canvas.height);
  return Math.max(2, target / longEdge);   // never below 2× (retina floor)
}

/**
 * Render + PNG-encode the poster at the highest resolution the browser can
 * handle, stepping down through EXPORT_LONG_EDGES on failure.
 * `cropOpts` (optional): { paddingBelow, minHeight } in DESIGN pixels —
 * multiplied by the chosen scale before cropping the trailing black gap.
 * Returns { blob, width, height } or null if every tier failed.
 */
async function renderExportBlob(cropOpts = null) {
  for (const target of EXPORT_LONG_EDGES) {
    const scale = scaleForLongEdge(target);
    let out;
    try {
      out = renderToHighResCanvas(scale);
      if (cropOpts) {
        out = exportCanvasCroppedToContent(out, {
          paddingBelow: cropOpts.paddingBelow * scale,
          minHeight:    cropOpts.minHeight * scale,
        });
      }
    } catch {
      continue;   // allocation failed at this size — try smaller
    }
    // toBlob returns null (or throws) when the canvas is too large to encode.
    const blob = await new Promise((resolve) => {
      try { out.toBlob(resolve, "image/png"); } catch { resolve(null); }
    });
    if (blob && blob.size > 2000) {
      return { blob, width: out.width, height: out.height };
    }
  }
  return null;
}

// The X export stays at 2× — X rejects PNG uploads over 5 MB, and a full
// 4K/8K poster PNG blows well past that.
const X_EXPORT_SCALE = 2;

// Text-preview paragraph font (the bullet copy drawn on the canvas in "Text"
// mode). Keep the paragraph copy firmly bold in both measure and draw passes
// so the rendered text doesn't drift between lighter/heavier states.
const PREVIEW_TEXT_WEIGHT = 700;
const PREVIEW_TEXT_FONT = "'Poppins', 'Segoe UI', Arial, sans-serif";

const IMAGE_PAN_LIMIT = 900;
const IMAGE_PAN_HEADROOM = 1.1;

/**
 * Render the poster onto an offscreen canvas at `scale`× the design size and
 * return that canvas. Used for exporting at higher resolution than the live
 * preview (Download, Post-to-X). All draw functions read `canvas.width` and
 * `canvas.height` for layout — those stay at design size, while the export
 * ctx is scaled, so pixels come out at scale× density without changing a
 * single coordinate in the renderer.
 */
function renderToHighResCanvas(scale = 2) {
  const exportCanvas = document.createElement("canvas");
  exportCanvas.width  = canvas.width  * scale;
  exportCanvas.height = canvas.height * scale;
  const exportCtx = exportCanvas.getContext("2d");
  // High-quality image scaling for any upscale during cover-image draw
  exportCtx.imageSmoothingEnabled = true;
  exportCtx.imageSmoothingQuality = "high";
  exportCtx.scale(scale, scale);

  // Swap the module-level ctx → all draw calls inside renderPoster() now
  // target the offscreen canvas. Restore immediately after.
  const previous = ctx;
  const prevTargeted = state._targetedRender;
  ctx = exportCtx;
  state._targetedRender = true;   // paint this one canvas, not all three cards
  try {
    renderPoster();
  } finally {
    ctx = previous;
    state._targetedRender = prevTargeted;
  }
  return exportCanvas;
}

const scrapeForm = document.getElementById("scrape-form");
const scrapeUrlInput = document.getElementById("scrape-url");
const scrapeButton = document.getElementById("scrape-btn");
const scrapeStatus = document.getElementById("scrape-status");
const downloadButton = document.getElementById("download-btn");
const textDownloadButton = document.getElementById("text-download-btn");
const previewModeToggle = document.getElementById("preview-mode-toggle");
const agentAuthGate = document.getElementById("agent-auth-gate");
const agentAuthMessage = document.getElementById("agent-auth-message");
const agentAuthRetry = document.getElementById("agent-auth-retry");
const agentAccount = document.getElementById("agent-account");
const agentAccountName = document.getElementById("agent-account-name");
const agentLogout = document.getElementById("agent-logout");

const editPanel = document.getElementById("edit-panel");
const imagePanel = document.getElementById("image-panel");
const headlineEdit = document.getElementById("headline-edit");
const detailEdit = document.getElementById("detail-edit");
const imgOffsetX = document.getElementById("img-offset-x");
const imgOffsetY = document.getElementById("img-offset-y");
const imgResetBtn = document.getElementById("img-reset-btn");
const bgImageUpload = document.getElementById("bg-image-upload");
const bgUploadZone = document.getElementById("bg-upload-zone");
const bgPasteBtn = document.getElementById("bg-paste-btn");
const stockImagesSection = document.getElementById("stock-images-section");
const stockImagesGrid = document.getElementById("stock-images-grid");
const imgZoom = document.getElementById("img-zoom");
const fontSizeInput = document.getElementById("font-size");
const accentColorInput = document.getElementById("accent-color");
const accentHexLabel = document.getElementById("accent-hex");
const overlayOpacityInput = document.getElementById("overlay-opacity");
const tagPresetsContainer = document.getElementById("tag-presets");

const faceDetector =
  typeof window !== "undefined" && "FaceDetector" in window
    ? new FaceDetector({ fastMode: true, maxDetectedFaces: 1 })
    : null;

const SHORTLY_AGENTS_URL = "https://shortlyagents.vercel.app/";
const AGENT_TOKEN_STORAGE_KEY = "pixagent.shortlyToken";

/* ── Aspect-ratio layout presets ──
   Each preset defines the canvas size + every key element's position so a
   single render path can produce posters in different aspect ratios.
   9:16 is the original Zeplin spec; the others are tuned to look right at
   their respective dimensions. Tweak numbers per preset, not in renderPoster. */
/* Each preset's `headline.bottomPadding` is the gap (px) between the bottom
   of the LAST headline line and the canvas bottom. The headline's actual y
   position is computed at render time from:
       top = canvas.height - bottomPadding - blockHeight
   so the headline always anchors to the bottom of the canvas no matter how
   many lines it wraps to. The gradient.fadeHeight defines how tall the
   transparent→black fade is above the headline. */
const LAYOUT_PRESETS = {
  "9:16": {
    label: "9:16",
    sub:   "Story / Reel",
    W: 920,  H: 1700,
    logo:     { centerX: 810, centerY: 150, slotPix: 100, slotShortly: 112 },
    /* 9:16 leaves room for the preview engagement + nav bars while keeping
       the headline closer to the likes row. */
    headline: { x: 64, bottomPadding: 305, maxWidth: 920 - 128, defaultSize: 49 },
    tag:      { x: 64, gapAboveHeadline: 16 },
    gradient: { fadeHeight: 330 },
    showPreviewBars: true,
  },
  "4:5": {
    label: "4:5",
    sub:   "Feed Portrait",
    W: 1080, H: 1350,
    logo:     { centerX: 970, centerY: 130, slotPix: 92,  slotShortly: 104 },
    headline: { x: 70, bottomPadding: 110, maxWidth: 1080 - 140, defaultSize: 52 },
    tag:      { x: 70, gapAboveHeadline: 14 },
    gradient: { fadeHeight: 300 },
    showPreviewBars: false,
  },
  "1:1": {
    label: "1:1",
    sub:   "Square",
    W: 1080, H: 1080,
    logo:     { centerX: 970, centerY: 120, slotPix: 90, slotShortly: 102 },
    headline: { x: 70, bottomPadding: 90, maxWidth: 1080 - 140, defaultSize: 50 },
    tag:      { x: 70, gapAboveHeadline: 14 },
    gradient: { fadeHeight: 280 },
    showPreviewBars: false,
  },
  "16:9": {
    label: "16:9",
    sub:   "Wide",
    W: 1920, H: 1080,
    logo:     { centerX: 1810, centerY: 110, slotPix: 90, slotShortly: 102 },
    /* Tighter maxWidth + bigger font so the headline wraps to ~3 lines
       and reads with the same prominence as the portrait presets. */
    headline: { x: 90, bottomPadding: 100, maxWidth: 1200, defaultSize: 64 },
    tag:      { x: 90, gapAboveHeadline: 14 },
    gradient: { fadeHeight: 300 },
    showPreviewBars: false,
  },
};

/* ── State ── */

const state = {
  aspectRatio: "9:16",         // key into LAYOUT_PRESETS
  accent: "#3979FF",
  headline: "",
  detailText: "",
  sourceUrl: "",               // article URL from the last scrape (grounds the AI writer)
  articleText: "",             // full scraped body text — what actually grounds the AI writer
  mainImage: null,
  ready: false,
  imageOffset: { x: 0, y: 0 },
  imageZoom: 100,
  headlineStyle: "half-purple",
  fontSize: 0, // 0 = auto
  overlayOpacity: 100,
  enhanceStrength: 70,      // percent of the AI upscale to keep
  logoX: 810,
  logoY: 80,
  logoSize: 110,
  logoImage: null,
  shortlyLogoImage: null,   // alt logo used when exporting for X
  useShortlyLogo: false,    // toggled by the X download handler
  previewMode: "pix",       // "pix" | "x" | "text" | "video"

  /* ── Slide 2 video ──
     Slide 2 is either the Text card or a trimmed, branded video clip.
     `videoEl` is the <video> element itself — drawn straight to the canvas
     in preview, and the source of truth for trim bounds. `videoFile` is set
     for local uploads, `videoUrl` for scraped YouTube/Instagram links; the
     export path picks whichever is present. */
  videoEl: null,
  videoUrl: "",             // resolved source URL (scrape path)
  videoFile: null,          // File object (local upload path)
  videoMeta: null,          // { title, duration, uploader, ... } from /resolve
  videoSourceKind: "link",  // "link" | "file"
  trimStart: 0,
  trimEnd: 0,
  videoMuted: false,
  videoExporting: false,
  // Framing for the video slide. A landscape clip cropped to 9:16 loses most
  // of its width, so which slice you keep matters — normalised 0..1 so the
  // same value drives the canvas preview and ffmpeg's crop regardless of
  // resolution.
  videoFocus: { x: 0.5, y: 0.5 },
  // null = use the current date at paint time. Only set to a Date if a
  // specific day ever needs pinning; leaving it null is what keeps an
  // open tab honest across midnight.
  createdAt: null,
  showTimestamp: true,
  videoCaption: "",         // burned into the clip, bottom-anchored
  videoCaptionSize: 40,     // design px at 920×1700; scaled per ratio
  secondLogoImage: null,
  tag: "none",       // "none" | "trending" | "breaking" | "swipe-video" (+ "-text" variants)
  tagImages: {},     // { trending: Image, breaking: Image } — SVG-backed tags only
  isDownloading: false,
  forceTextExport: false,
  imageSelectionNonce: 0,
  productImageAnalysis: null,
  agentAuthenticated: false,
  agentUser: null,

  /* ── Image filters (CSS-style values applied via ctx.filter) ── */
  filterBrightness: 100,    // 0–200 (100 = neutral)
  filterContrast:   100,    // 0–200
  filterSaturation: 100,    // 0–200
  filterBlur:       0,      // 0–20 px
  filterPreset:     "none", // identifier of the active preset chip, if any
};

initAgentAccess();

// Build the ctx.filter string from current state values.
function buildFilterString() {
  return [
    `brightness(${state.filterBrightness}%)`,
    `contrast(${state.filterContrast}%)`,
    `saturate(${state.filterSaturation}%)`,
    `blur(${state.filterBlur}px)`,
  ].join(" ");
}

// Filter presets — pure value bundles, applied by clicking a chip.
const FILTER_PRESETS = {
  "none":    { brightness: 100, contrast: 100, saturation: 100, blur: 0 },
  "vivid":   { brightness: 105, contrast: 120, saturation: 145, blur: 0 },
  "bw":      { brightness: 105, contrast: 110, saturation: 0,   blur: 0 },
  "warm":    { brightness: 102, contrast: 108, saturation: 130, blur: 0 },
  "cool":    { brightness: 100, contrast: 110, saturation: 90,  blur: 0 },
  "faded":   { brightness: 108, contrast: 88,  saturation: 80,  blur: 0 },
  "soft":    { brightness: 105, contrast: 95,  saturation: 105, blur: 1 },
};

// Active layout preset (always read through this; never hard-code coords).
function getLayout() {
  return LAYOUT_PRESETS[state.aspectRatio] || LAYOUT_PRESETS["9:16"];
}

/* ── Highlight bracket syntax ──
   Users wrap words to highlight them. All three pairs are equivalent:
       [Modi]     (Modi)     {Modi}
   We expose a single character class that matches any of those six chars,
   so every place that strips/checks brackets goes through these. */
const HIGHLIGHT_OPEN_CHAR  = /[\[({]/;     // matches  [  (  {
const HIGHLIGHT_CLOSE_CHAR = /[\])}]/;     // matches  ]  )  }
const HIGHLIGHT_ANY_CHARS_GLOBAL = /[\[\](){}]/g;  // any bracket char, /g for replace

// Switch ratio: resize canvas, reset any pan that no longer makes sense, re-render.
function applyAspectRatio(ratio) {
  if (!LAYOUT_PRESETS[ratio]) return;
  state.aspectRatio = ratio;
  const L = LAYOUT_PRESETS[ratio];
  canvas.width = L.W;
  canvas.height = L.H;
  // Reset image pan (positions vary too much across ratios to preserve)
  state.imageOffset = { x: 0, y: 0 };
  if (typeof imgOffsetX !== "undefined") imgOffsetX.value = 0;
  if (typeof imgOffsetY !== "undefined") imgOffsetY.value = 0;
  // Update the size badge in the preview header
  const px = document.querySelector(".preview-pixels");
  if (px) px.textContent = `${L.W} × ${L.H}`;
  renderPoster();
}

/* ── Drag state (not part of poster state) ── */
let isDragging = false;
let dragStart = { x: 0, y: 0 };
let dragOffsetStart = { x: 0, y: 0 };

const defaultMain = makeMainPlaceholder();

/* ── Load the real Pix logo ── */
const pixLogo = new Image();
pixLogo.src = "./assests/pix-logo.png";
pixLogo.onload = () => {
  state.logoImage = pixLogo;
  renderPoster();
};
pixLogo.onerror = () => {
  console.warn("Logo failed to load — using text fallback.");
};

// Alt logo used only when exporting for X downloads.
// PNG, square — same aspect ratio as Pix logo, so the existing slot scaler
// handles it identically (130×130 slot for X exports, see drawFixedLogos).
const shortlyLogo = new Image();
shortlyLogo.src = "./assests/shortly-logo.png";
shortlyLogo.onload = () => {
  state.shortlyLogoImage = shortlyLogo;
  renderPoster();
  console.log("✓ Shortly logo loaded — will be used for X exports");
};
shortlyLogo.onerror = () => {
  console.error("✗ Shortly logo failed to load from", shortlyLogo.src, "— X exports will fall back to Pix logo.");
};


/* ── Load tag SVGs ── */
const tagFiles = {
  "trending": "./assests/Trending.svg",
  "trending-text": "./assests/Trending without logo.svg",
  "breaking": "./assests/Braking.svg",
  "breaking-text": "./assests/Breaking without icon.svg"
};
Object.entries(tagFiles).forEach(([key, src]) => {
  const img = new Image();
  img.src = src;
  img.onload = () => { state.tagImages[key] = img; renderPoster(); };
});

/* ── Canvas-drawn tags ──
   Same 37px bar as the SVG tags above, but painted with ctx so the label uses
   the Poppins the page already loads instead of needing an outlined SVG. */
const TAG_BAR_HEIGHT = 37;   // matches the SVG tag assets
const TAG_PAD_X      = 12;   // side padding around the label
const TAG_ICON_BOX   = 22;   // the glyph is drawn inside this square
const TAG_ICON_GAP   = 10;   // space between glyph and label
const TAG_FONT       = "600 21px 'Poppins', 'Segoe UI', Arial, sans-serif";

// Brand blue, matching the headline accent.
const DRAWN_TAGS = {
  "swipe-video":      { label: "Swipe for Video", bg: "#3979FF", icon: true },
  "swipe-video-text": { label: "Swipe for Video", bg: "#3979FF", icon: false }
};

// Wait for both Poppins AND Roboto Serif fonts to load before first render
document.fonts.ready.then(async () => {
  // Ensure Roboto Serif is loaded for headline rendering, and Poppins for the
  // drawn tag badges — their width comes from measureText, so a fallback font
  // at first paint would size the bar wrong.
  try {
    await document.fonts.load("600 49px 'Roboto Serif'");
    await document.fonts.load(TAG_FONT);
  } catch (e) { /* font may already be loaded */ }
  await waitForImage(defaultMain);
  await ensureImageFocalPoint(defaultMain);
  renderPoster();
});

/* ── Events ── */

// Mode tab switching
const modeTabs = document.getElementById("mode-tabs");
const writeForm = document.getElementById("write-form");
const writeHeadline = document.getElementById("write-headline");
const writeDetail = document.getElementById("write-detail");
const writeApplyBtn = document.getElementById("write-apply-btn");
const writeStatus = document.getElementById("write-status");

modeTabs.addEventListener("click", (e) => {
  const tab = e.target.closest(".mode-tab");
  if (!tab) return;
  modeTabs.querySelectorAll(".mode-tab").forEach(t => t.classList.remove("active"));
  tab.classList.add("active");

  const mode = tab.dataset.mode;
  if (mode === "link") {
    scrapeForm.hidden = false;
    writeForm.hidden = true;
  } else {
    scrapeForm.hidden = true;
    writeForm.hidden = false;
  }
});

if (previewModeToggle) {
  previewModeToggle.addEventListener("click", (e) => {
    const btn = e.target.closest(".preview-mode-btn");
    if (!btn) return;
    const mode = ["pix", "x", "text", "video"].includes(btn.dataset.previewMode) ? btn.dataset.previewMode : "pix";
    state.previewMode = mode;
    syncPreviewModeUI();
    // Video mode drives its own repaint loop while the clip plays.
    if (mode === "video") startVideoPreviewLoop(); else stopVideoPreviewLoop();
    if (mode === "text" && state.aspectRatio !== "9:16") {
      applyAspectRatio("9:16");
      return;
    }
    renderPoster();
  });
}

function setWriteStatus(message, type) {
  if (!writeStatus) return;
  writeStatus.textContent = message || "";
  writeStatus.className = "status-text";
  if (type) writeStatus.classList.add(type);
}

if (agentAuthRetry) {
  agentAuthRetry.addEventListener("click", () => {
    initAgentAccess({ forceRefresh: true });
  });
}

if (agentLogout) {
  agentLogout.addEventListener("click", logoutAgentUser);
}

async function initAgentAccess({ forceRefresh = false } = {}) {
  setAgentAuthState("checking", "Checking your Shortly Agents login...");

  const params = new URLSearchParams(window.location.search);
  const urlToken = params.get("token") || params.get("access_token") || "";
  if (urlToken) {
    sessionStorage.setItem(AGENT_TOKEN_STORAGE_KEY, urlToken);
    params.delete("token");
    params.delete("access_token");
    const cleanQuery = params.toString();
    const cleanUrl = `${window.location.pathname}${cleanQuery ? `?${cleanQuery}` : ""}${window.location.hash}`;
    window.history.replaceState({}, "", cleanUrl);
  }

  const token = forceRefresh ? "" : (urlToken || sessionStorage.getItem(AGENT_TOKEN_STORAGE_KEY) || "");

  try {
    const response = await fetch("/api/agent-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.authenticated) {
      sessionStorage.removeItem(AGENT_TOKEN_STORAGE_KEY);
      setAgentAuthState("blocked", payload.error || "Open Pix from Shortly Agents to continue.");
      return;
    }

    state.agentAuthenticated = true;
    state.agentUser = payload.user || getUserFromAgentToken(token) || null;
    const name = getAgentDisplayName();
    syncAgentAccount();
    setAgentAuthState("ready", `Signed in as ${name}.`);
  } catch {
    setAgentAuthState("blocked", "Could not verify Shortly Agents access. Try again or open Shortly Agents.");
  }
}

function setAgentAuthState(status, message) {
  document.body.classList.remove("auth-checking", "auth-ready", "auth-blocked");
  document.body.classList.add(status === "ready" ? "auth-ready" : status === "blocked" ? "auth-blocked" : "auth-checking");
  if (agentAuthMessage) agentAuthMessage.textContent = message || "";
  if (agentAuthGate) agentAuthGate.hidden = status === "ready";
  if (status !== "ready") {
    state.agentAuthenticated = false;
    state.agentUser = null;
    syncAgentAccount();
  }
}

function getAgentDisplayName() {
  return state.agentUser?.displayName || state.agentUser?.username || "Shortly user";
}

function syncAgentAccount() {
  const hasSession = Boolean(state.agentAuthenticated);
  if (agentAccountName) agentAccountName.textContent = getAgentDisplayName();
  if (agentAccount) agentAccount.hidden = !hasSession;
  if (agentLogout) agentLogout.hidden = !hasSession;
}

function getUserFromAgentToken(token) {
  const payload = decodeAgentTokenPayload(token);
  if (!payload) return null;
  return {
    loginId: payload.loginId || payload.id || null,
    agentId: payload.agentId || "pix-post-agent",
    username: payload.username || null,
    displayName: payload.displayName || payload.name || payload.username || null,
  };
}

function decodeAgentTokenPayload(token) {
  const payloadPart = String(token || "").split(".")[0];
  if (!payloadPart) return null;
  try {
    const normalized = payloadPart.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    return JSON.parse(atob(padded));
  } catch {
    return null;
  }
}

function logoutAgentUser() {
  sessionStorage.removeItem(AGENT_TOKEN_STORAGE_KEY);
  state.agentAuthenticated = false;
  state.agentUser = null;
  syncAgentAccount();
  window.location.assign(SHORTLY_AGENTS_URL);
}

function resetImageControls() {
  state.imageOffset = { x: 0, y: 0 };
  state.imageZoom = 100;
  imgOffsetX.value = 0;
  imgOffsetY.value = 0;
  imgZoom.value = 100;
}

function claimImageSelection() {
  state.imageSelectionNonce += 1;
  return state.imageSelectionNonce;
}

function isXRenderMode() {
  return state.useShortlyLogo || (!state.isDownloading && state.previewMode === "x");
}

function isTextPreviewMode() {
  return state.previewMode === "text" && (!state.isDownloading || state.forceTextExport);
}

// True while painting the video slide. `videoOverlayExport` is set only by
// renderVideoOverlayPng(), which needs the branding layer on transparency
// with no video frame and no mockup chrome underneath it.
function isVideoPreviewMode() {
  return state.previewMode === "video" || state.videoOverlayExport;
}

function syncPreviewModeUI() {
  if (!previewModeToggle) return;
  previewModeToggle.querySelectorAll(".preview-mode-btn").forEach((btn) => {
    const active = btn.dataset.previewMode === state.previewMode;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-checked", active ? "true" : "false");
  });
  updatePrimaryDownloadButton();
}

function updatePrimaryDownloadButton() {
  // Update only the label span — the button also contains an SVG icon that
  // textContent assignment on the button itself would wipe out.
  const label = document.getElementById("download-btn-label");
  if (label) label.textContent = "Download Poster";
}

updatePrimaryDownloadButton();

function buildFallbackImageSuggestions(searchQuery, count = 6) {
  const words = searchQuery
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 4);
  const label = (words.join(" ") || "news").toUpperCase();
  const palettes = [
    ["#0f172a", "#7c3aed", "#22d3ee"],
    ["#111827", "#ef4444", "#f59e0b"],
    ["#082f49", "#14b8a6", "#eab308"],
    ["#18181b", "#e11d48", "#a3e635"],
    ["#1e1b4b", "#2563eb", "#f97316"],
    ["#052e16", "#16a34a", "#38bdf8"],
  ];

  return Array.from({ length: count }, (_, index) => {
    const [base, accent, glow] = palettes[index % palettes.length];
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1800" viewBox="0 0 1200 1800">
        <defs>
          <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stop-color="${base}"/>
            <stop offset="58%" stop-color="#050505"/>
            <stop offset="100%" stop-color="${accent}"/>
          </linearGradient>
          <radialGradient id="g1" cx="${20 + index * 11}%" cy="${18 + index * 7}%" r="58%">
            <stop offset="0%" stop-color="${glow}" stop-opacity="0.72"/>
            <stop offset="100%" stop-color="${glow}" stop-opacity="0"/>
          </radialGradient>
          <filter id="blur"><feGaussianBlur stdDeviation="36"/></filter>
        </defs>
        <rect width="1200" height="1800" fill="url(#bg)"/>
        <circle cx="${260 + index * 120}" cy="${260 + index * 95}" r="360" fill="url(#g1)" filter="url(#blur)"/>
        <circle cx="${940 - index * 70}" cy="${1120 + index * 46}" r="420" fill="${accent}" opacity="0.22" filter="url(#blur)"/>
        <g opacity="0.22" stroke="#fff" stroke-width="2">
          ${Array.from({ length: 18 }, (_, line) => `<path d="M${line * 84 - 220} 0 L${line * 84 + 520} 1800"/>`).join("")}
        </g>
        <text x="88" y="220" fill="#fff" opacity="0.22" font-family="Arial, sans-serif" font-size="64" font-weight="800">${escapeSvgText(label)}</text>
      </svg>
    `;
    const imageUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    return {
      id: `fallback-${index + 1}`,
      alt: `${searchQuery} related image`,
      preview: imageUrl,
      image: imageUrl,
      imageProxy: imageUrl,
      source: "fallback",
    };
  });
}

function escapeSvgText(value) {
  return value.replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&apos;",
  }[ch]));
}

// Write mode — build poster from manual text
writeApplyBtn.addEventListener("click", async () => {
  const text = writeHeadline.value.trim();
  if (!text) return;
  // Slide 2 is NOT a reprint of slide 1. Falling back to the headline here
  // put the same sentence on both cards, which is the "text paragraph shows
  // the headline" bug and also what the editorial spec forbids.
  const detail = writeDetail.value.trim();
  state.headline = text;
  state.detailText = limitDetailTextClient(detail);
  headlineEdit.value = text;
  if (detailEdit) detailEdit.value = state.detailText;
  editPanel.hidden = false;
  imagePanel.hidden = false;
  renderPoster();
  scrollPreviewIntoViewIfMobile();
  closeSheetIfMobile();

  writeApplyBtn.disabled = true;
  setWriteStatus("Finding matching images...");
  await fetchStockImages(text, {
    autoApplyRandom: true,
    onStatus: setWriteStatus,
  });
  writeApplyBtn.disabled = false;
});

// Live sync: write-headline → headline-edit → poster
writeHeadline.addEventListener("input", () => {
  state.headline = writeHeadline.value;
  headlineEdit.value = writeHeadline.value;
  setWriteStatus("");
  renderPoster();
});

writeDetail.addEventListener("input", (event) => {
  const text = event.inputType === "insertLineBreak" ? formatDetailBulletField(writeDetail) : writeDetail.value;
  state.detailText = limitDetailTextClient(text);
  if (detailEdit) detailEdit.value = state.detailText;
  setWriteStatus("");
  renderPoster();
});
writeDetail.addEventListener("keydown", handleDetailBulletEnter);

scrapeForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await runScrape();
});

// On mobile, after a Build, scroll the preview into view so the user
// gets visual confirmation without having to scroll up.
function scrollPreviewIntoViewIfMobile() {
  if (window.matchMedia("(max-width: 760px)").matches) {
    const previewPanel = document.querySelector(".preview-panel");
    if (previewPanel) {
      // Use rAF so the DOM has settled (panels may have just become visible).
      requestAnimationFrame(() => {
        previewPanel.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    }
  }
}

/* ── Download for X ── */
const xDownloadBtn = document.getElementById("x-download-btn");
const xDownloadStatus = document.getElementById("x-download-status");

function setPostStatus(msg, kind) {
  if (!xDownloadStatus) return;
  xDownloadStatus.className = "status-text" + (kind ? ` ${kind}` : "");
  xDownloadStatus.textContent = "";
  if (msg) xDownloadStatus.append(msg);
}

// Crop the canvas vertically to where the last non-black pixel lives, so the
// exported PNG doesn't ship the trailing black gradient gap below the headline.
// `paddingBelow`: extra px to keep below the last content row (breathing room).
// `minHeight`:   never crop above this height (avoids ugly squares for short headlines).
function exportCanvasCroppedToContent(srcCanvas, { paddingBelow = 32, minHeight = 1100 } = {}) {
  const w = srcCanvas.width;
  const h = srcCanvas.height;
  const sctx = srcCanvas.getContext("2d");

  // Pull the bottom 60% of the canvas in ONE getImageData call (fast).
  // 60% covers the gradient + headline area; we won't have content above that.
  const scanStart = Math.max(0, Math.floor(h * 0.4));
  const scanH = h - scanStart;
  let lastContentY = h;
  try {
    const data = sctx.getImageData(0, scanStart, w, scanH).data;
    const rowBytes = w * 4;
    const THRESHOLD = 12;  // RGB channel value above which we call it "content"

    // Scan rows bottom-up; first row with any non-black pixel = content end
    outer:
    for (let row = scanH - 1; row >= 0; row--) {
      const rowOffset = row * rowBytes;
      for (let col = 0; col < rowBytes; col += 4) {
        if (
          data[rowOffset + col]     > THRESHOLD ||
          data[rowOffset + col + 1] > THRESHOLD ||
          data[rowOffset + col + 2] > THRESHOLD
        ) {
          lastContentY = scanStart + row + 1;
          break outer;
        }
      }
    }
  } catch (e) {
    // CORS taint or similar — bail out and just use the full canvas
    console.warn("Crop scan failed, exporting full canvas:", e);
    return srcCanvas;
  }

  // Compute final crop height with padding + min-height clamp + max bound
  const cropH = Math.max(minHeight, Math.min(h, lastContentY + paddingBelow));
  if (cropH >= h) return srcCanvas;  // nothing to crop

  const out = document.createElement("canvas");
  out.width = w;
  out.height = cropH;
  out.getContext("2d").drawImage(srcCanvas, 0, 0, w, cropH, 0, 0, w, cropH);
  return out;
}

// Returns { caption, source: "ai" | "fallback", error? }
async function fetchAiCaption(headline, timeoutMs = 12000) {
  const fallback = headline.replace(HIGHLIGHT_ANY_CHARS_GLOBAL, "").trim().slice(0, 280);
  if (!headline.trim()) return { caption: fallback, source: "fallback", error: "empty headline" };
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const resp = await fetch("/api/generate-caption", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ headline }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);

    if (!resp.ok) {
      let detail = `HTTP ${resp.status}`;
      try { const j = await resp.json(); detail = j.error || detail; } catch {}
      console.error("[AI caption] server returned:", detail);
      return { caption: fallback, source: "fallback", error: detail };
    }
    const data = await resp.json();
    const c = (data?.caption || "").trim();
    if (!c) return { caption: fallback, source: "fallback", error: "empty AI response" };
    console.log("[AI caption] success:", c);
    return { caption: c, source: "ai" };
  } catch (e) {
    const msg = e?.name === "AbortError" ? "timeout" : (e?.message || String(e));
    console.error("[AI caption] fetch failed:", msg);
    return { caption: fallback, source: "fallback", error: msg };
  }
}

function downloadXPreview({ usePrimaryButton = false } = {}) {
  const headline = (state.headline || "").trim();
  if (!headline) {
    setPostStatus("Build a poster first.", "error");
    return;
  }

  const targetButton = usePrimaryButton ? downloadButton : xDownloadBtn;
  if (targetButton) targetButton.disabled = true;
  setPostStatus("Preparing X download...");

  // Explicitly own the render mode so a stale "text" preview / forceTextExport
  // can never leak the text image into the X export. Restore the user's
  // on-screen preview mode afterwards.
  const prevMode = state.previewMode;
  state.isDownloading = true;
  state.useShortlyLogo = true;
  state.forceTextExport = false;
  state.previewMode = "x";

  const restore = () => {
    state.isDownloading = false;
    state.useShortlyLogo = false;
    state.forceTextExport = false;
    state.previewMode = prevMode;
    renderPoster();
    if (targetButton) targetButton.disabled = false;
  };

  try {
    const exportCanvas = renderToHighResCanvas(X_EXPORT_SCALE);
    const cropped = exportCanvasCroppedToContent(exportCanvas, {
      paddingBelow: 36   * X_EXPORT_SCALE,
      minHeight:    1100 * X_EXPORT_SCALE,
    });

    cropped.toBlob((blob) => {
      restore();
      if (!blob) {
        setPostStatus("Couldn't render image.", "error");
        return;
      }
      const blobUrl = URL.createObjectURL(blob);
      const dl = document.createElement("a");
      dl.href = blobUrl;
      dl.download = `${slugify(headline || "pix-post")}-x.png`;
      dl.click();
      setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
      setPostStatus("X-ready PNG downloaded.", "success");
    }, "image/png");
  } catch (error) {
    restore();
    setPostStatus("Couldn't render X download.", "error");
    console.error("X download failed:", error);
  }
}

if (xDownloadBtn) xDownloadBtn.addEventListener("click", () => {
  downloadXPreview();
});

async function downloadTextPreview() {
  const headline = (state.headline || "").trim();
  if (!headline && !getDetailTextForPreview().trim()) {
    setPostStatus("Build a poster first.", "error");
    return;
  }

  if (textDownloadButton) textDownloadButton.disabled = true;
  setPostStatus("Rendering high-resolution text image…");

  const previousMode = state.previewMode;
  state.isDownloading = true;
  state.forceTextExport = true;
  state.previewMode = "text";

  let result = null;
  try {
    result = await renderExportBlob();
  } catch (error) {
    console.error("Text download failed:", error);
  } finally {
    state.isDownloading = false;
    state.forceTextExport = false;
    state.previewMode = previousMode;
    renderPoster();
    if (textDownloadButton) textDownloadButton.disabled = false;
  }

  if (!result) {
    setPostStatus("Couldn't render text image.", "error");
    return;
  }
  const blobUrl = URL.createObjectURL(result.blob);
  const dl = document.createElement("a");
  dl.href = blobUrl;
  dl.download = `${slugify(headline || "pix-post")}-text.png`;
  dl.click();
  setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
  setPostStatus(`Text PNG downloaded (${result.width}×${result.height}).`, "success");
}

if (textDownloadButton) textDownloadButton.addEventListener("click", () => {
  downloadTextPreview();
});

// The single "Download Poster" button is gone — each card owns its export
// now. This block is kept behind a guard so an older markup revision (or a
// cached page) still works rather than throwing at load.
if (downloadButton) downloadButton.addEventListener("click", async () => {
  // Clean export (no preview overlays). The export happens entirely on an
  // offscreen canvas via renderExportBlob (8K→6K→4K fallback), so the
  // on-screen preview never changes; we restore state + re-render after.
  downloadButton.disabled = true;
  setStatus("Rendering high-resolution poster…");

  // Explicitly own the render mode → always the Pix poster, never text/X,
  // regardless of the current preview toggle or leftover flags.
  const prevMode = state.previewMode;
  state.isDownloading = true;
  state.forceTextExport = false;
  state.useShortlyLogo = false;
  state.previewMode = "pix";

  let result = null;
  try {
    result = await renderExportBlob();
  } catch (err) {
    console.error("Download failed:", err);
  } finally {
    state.isDownloading = false;
    state.previewMode = prevMode;
    renderPoster();  // Restore preview
    downloadButton.disabled = false;
  }

  if (!result) {
    setStatus("Failed to generate high-resolution export.", "error");
    return;
  }
  const url = URL.createObjectURL(result.blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${slugify(state.headline || "pix-post")}.png`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  setStatus(`Poster downloaded (${result.width}×${result.height}).`, "success");
});

// Headline live edit
headlineEdit.addEventListener("input", () => {
  state.headline = headlineEdit.value;
  writeHeadline.value = headlineEdit.value;
  // Editing the headline used to overwrite the paragraph whenever a
  // heuristic guessed the paragraph "was" the headline. The guess misfired,
  // silently replacing real bullet copy. The two fields are independent now.
  renderPoster();
});

if (detailEdit) {
  detailEdit.addEventListener("input", (event) => {
    const text = event.inputType === "insertLineBreak" ? formatDetailBulletField(detailEdit) : detailEdit.value;
    state.detailText = limitDetailTextClient(text);
    writeDetail.value = state.detailText;
    renderPoster();
  });
  detailEdit.addEventListener("keydown", handleDetailBulletEnter);
}

// Image offset sliders
imgOffsetX.addEventListener("input", () => {
  state.imageOffset.x = Number(imgOffsetX.value);
  renderPoster();
});

imgOffsetY.addEventListener("input", () => {
  state.imageOffset.y = Number(imgOffsetY.value);
  renderPoster();
});

imgResetBtn.addEventListener("click", () => {
  // Pan + zoom reset
  state.imageOffset = { x: 0, y: 0 };
  state.imageZoom = 100;
  imgOffsetX.value = 0;
  imgOffsetY.value = 0;
  imgZoom.value = 100;

  // Filters reset
  applyFilterPreset("none");

  renderPoster();
});

/* ── Filters ── */
const filterBrightnessInput = document.getElementById("filter-brightness");
const filterContrastInput   = document.getElementById("filter-contrast");
const filterSaturationInput = document.getElementById("filter-saturation");
const filterBlurInput       = document.getElementById("filter-blur");
const filterPresetsContainer = document.getElementById("filter-presets");

function syncFilterUI() {
  if (filterBrightnessInput) filterBrightnessInput.value = state.filterBrightness;
  if (filterContrastInput)   filterContrastInput.value   = state.filterContrast;
  if (filterSaturationInput) filterSaturationInput.value = state.filterSaturation;
  if (filterBlurInput)       filterBlurInput.value       = state.filterBlur;
  if (filterPresetsContainer) {
    filterPresetsContainer.querySelectorAll(".preset-btn").forEach(b => {
      b.classList.toggle("active", b.dataset.filter === state.filterPreset);
    });
  }
}

function applyFilterPreset(name) {
  const p = FILTER_PRESETS[name] || FILTER_PRESETS["none"];
  state.filterBrightness = p.brightness;
  state.filterContrast   = p.contrast;
  state.filterSaturation = p.saturation;
  state.filterBlur       = p.blur;
  state.filterPreset     = name;
  syncFilterUI();
  // Reflect in the collapsed accordion header pill
  const meta = document.getElementById("acc-meta-filter");
  if (meta) {
    const labels = { none:"None", vivid:"Vivid", bw:"B&W", warm:"Warm", cool:"Cool", faded:"Faded", soft:"Soft", custom:"Custom" };
    meta.textContent = labels[name] || "";
  }
}

[
  [filterBrightnessInput, "filterBrightness"],
  [filterContrastInput,   "filterContrast"],
  [filterSaturationInput, "filterSaturation"],
  [filterBlurInput,       "filterBlur"],
].forEach(([el, key]) => {
  if (!el) return;
  el.addEventListener("input", () => {
    state[key] = Number(el.value);
    // Manual edit means it's no longer a known preset — clear active chip
    state.filterPreset = "custom";
    if (filterPresetsContainer) {
      filterPresetsContainer.querySelectorAll(".preset-btn")
        .forEach(b => b.classList.remove("active"));
    }
    const meta = document.getElementById("acc-meta-filter");
    if (meta) meta.textContent = "Custom";
    renderPoster();
  });
});

if (filterPresetsContainer) {
  filterPresetsContainer.addEventListener("click", (e) => {
    const btn = e.target.closest(".preset-btn");
    if (!btn) return;
    applyFilterPreset(btn.dataset.filter);
    renderPoster();
  });
}

// Zoom slider
imgZoom.addEventListener("input", () => {
  const nextZoom = Number(imgZoom.value);
  if (nextZoom < state.imageZoom) {
    state.imageOffset = { x: 0, y: 0 };
    imgOffsetX.value = 0;
    imgOffsetY.value = 0;
  }
  state.imageZoom = nextZoom;
  renderPoster();
});

// Font size slider (0 = auto)
fontSizeInput.addEventListener("input", () => {
  state.fontSize = Number(fontSizeInput.value);
  renderPoster();
});

// Accent color picker
accentColorInput.addEventListener("input", () => {
  state.accent = accentColorInput.value;
  accentHexLabel.textContent = accentColorInput.value.toUpperCase();
  document.querySelector('.color-circle').style.borderColor = state.accent;
  renderPoster();
});

// Overlay opacity slider
overlayOpacityInput.addEventListener("input", () => {
  state.overlayOpacity = Number(overlayOpacityInput.value);
  renderPoster();
});

// Tag presets
tagPresetsContainer.addEventListener("click", (e) => {
  const btn = e.target.closest(".preset-btn");
  if (!btn) return;
  tagPresetsContainer.querySelectorAll(".preset-btn").forEach(b => b.classList.remove("active"));
  btn.classList.add("active");
  state.tag = btn.dataset.tag;
  renderPoster();
});

// Aspect-ratio chips
const ratioPresetsContainer = document.getElementById("ratio-presets");
if (ratioPresetsContainer) {
  ratioPresetsContainer.addEventListener("click", (e) => {
    const btn = e.target.closest(".ratio-btn");
    if (!btn) return;
    const ratio = btn.dataset.ratio;
    if (!ratio || ratio === state.aspectRatio) return;
    ratioPresetsContainer.querySelectorAll(".ratio-btn").forEach(b => {
      b.classList.toggle("active", b === btn);
      b.setAttribute("aria-checked", b === btn ? "true" : "false");
    });
    applyAspectRatio(ratio);
    // Reflect in the collapsed accordion header pill
    const meta = document.getElementById("acc-meta-ratio");
    if (meta) meta.textContent = ratio;
  });
}

/* ── Accordion toggle ──
   Clicking a header flips the data-open attr on its parent .acc; CSS
   handles the smooth height transition via grid-template-rows.
   On mobile, toggling one section will close the others (single-open
   mode) so the panel stays compact. */
const isMobile = () => window.matchMedia("(max-width: 760px)").matches;

document.addEventListener("click", (e) => {
  const head = e.target.closest(".acc-head");
  if (!head) return;
  const acc  = head.parentElement;
  if (!acc || !acc.classList.contains("acc")) return;

  const opening = acc.dataset.open !== "true";
  if (opening && isMobile()) {
    // Single-open mode: close all sibling accordions inside the same .acc-list
    const list = acc.closest(".acc-list");
    if (list) {
      list.querySelectorAll(":scope > .acc[data-open='true']").forEach(o => {
        o.dataset.open = "false";
        const h = o.querySelector(":scope > .acc-head");
        if (h) h.setAttribute("aria-expanded", "false");
      });
    }
  }

  acc.dataset.open = opening ? "true" : "false";
  head.setAttribute("aria-expanded", opening ? "true" : "false");

  // When opening on mobile, scroll the header into a comfortable view
  if (opening && isMobile()) {
    requestAnimationFrame(() => {
      head.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
  }
});

/* ── Mobile bottom-sheet (FAB → controls popup) ──
   On mobile, the editor panels live inside .edit-sheet which is hidden
   off-screen by default. The FAB toggles `body.sheet-open` to slide it up;
   tapping the backdrop or the close button drops it back down. */
const fabEdit       = document.getElementById("fab-edit");
const sheetBackdrop = document.getElementById("sheet-backdrop");
const sheetClose    = document.getElementById("sheet-close");
const editSheet     = document.getElementById("edit-sheet");

function setSheetOpen(open) {
  document.body.classList.toggle("sheet-open", open);
  if (fabEdit) fabEdit.setAttribute("aria-expanded", open ? "true" : "false");
  if (sheetBackdrop) sheetBackdrop.setAttribute("aria-hidden", open ? "false" : "true");
  if (open && editSheet) {
    // Reset scroll to top when opening so the user starts at the first section
    requestAnimationFrame(() => editSheet.scrollTo({ top: 0, behavior: "instant" }));
  }
}

if (fabEdit)       fabEdit.addEventListener("click", () => setSheetOpen(!document.body.classList.contains("sheet-open")));
if (sheetBackdrop) sheetBackdrop.addEventListener("click", () => setSheetOpen(false));
if (sheetClose)    sheetClose.addEventListener("click", () => setSheetOpen(false));

/* ── Swipe-to-close gesture on the sheet handle ── */
(function attachSheetSwipe() {
  const handle = document.querySelector(".sheet-handle");
  if (!handle || !editSheet) return;

  let startY     = null;     // touch start clientY
  let dragY      = 0;        // current downward delta
  let isDragging = false;
  const CLOSE_PX = 90;       // drag this far → close

  function onStart(e) {
    if (!document.body.classList.contains("sheet-open")) return;
    const point = e.touches ? e.touches[0] : e;
    startY = point.clientY;
    dragY = 0;
    isDragging = true;
    // Disable CSS transition during drag so transform tracks finger 1:1
    editSheet.style.transition = "none";
  }

  function onMove(e) {
    if (!isDragging) return;
    const point = e.touches ? e.touches[0] : e;
    const dy = point.clientY - startY;
    if (dy <= 0) {
      // Pulling up — slight rubber-band, then clamp at 0
      dragY = Math.max(-12, dy / 6);
    } else {
      dragY = dy;
    }
    editSheet.style.transform = `translateY(${dragY}px)`;
  }

  function onEnd() {
    if (!isDragging) return;
    isDragging = false;
    editSheet.style.transition = "";   // restore CSS transition
    if (dragY > CLOSE_PX) {
      editSheet.style.transform = "";  // let .sheet-open class take over
      setSheetOpen(false);
    } else {
      editSheet.style.transform = "";  // snap back to fully open
    }
    startY = null;
    dragY = 0;
  }

  // Touch (iOS / Android)
  handle.addEventListener("touchstart", onStart, { passive: true });
  handle.addEventListener("touchmove",  onMove,  { passive: true });
  handle.addEventListener("touchend",   onEnd);
  handle.addEventListener("touchcancel", onEnd);

  // Pointer (desktop drag — useful for testing)
  handle.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    onStart(e);
    handle.setPointerCapture?.(e.pointerId);
  });
  handle.addEventListener("pointermove", onMove);
  handle.addEventListener("pointerup",   onEnd);
  handle.addEventListener("pointercancel", onEnd);
})();

// Close the sheet on Escape (a11y)
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && document.body.classList.contains("sheet-open")) setSheetOpen(false);
});

// Auto-close the sheet after a successful Build/scrape on mobile so the user
// instantly sees their poster.
function closeSheetIfMobile() {
  if (window.matchMedia("(max-width: 760px)").matches) setSheetOpen(false);
}

// On first load, collapse all accordions on mobile so the panel is compact
function setInitialAccordionState() {
  if (!isMobile()) return;
  document.querySelectorAll(".acc").forEach((acc, i) => {
    // Keep just the first accordion (Aspect Ratio) open by default
    const open = i === 0;
    acc.dataset.open = open ? "true" : "false";
    const h = acc.querySelector(":scope > .acc-head");
    if (h) h.setAttribute("aria-expanded", open ? "true" : "false");
  });
}
setInitialAccordionState();

// On mobile first load, open the sheet so the URL input + Build button are
// immediately visible. After a successful build, the sheet auto-closes
// (via closeSheetIfMobile) and the FAB takes over for re-editing.
if (window.matchMedia("(max-width: 760px)").matches) {
  setSheetOpen(true);
}
window.addEventListener("resize", () => {
  // Re-apply on viewport class crossings (mobile↔desktop) for sanity
  const isMob = isMobile();
  document.querySelectorAll(".acc").forEach((acc) => {
    if (!isMob) {
      acc.dataset.open = "true";
      const h = acc.querySelector(":scope > .acc-head");
      if (h) h.setAttribute("aria-expanded", "true");
    }
  });
});

// Background image upload
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

function getFirstImageFile(collection) {
  if (!collection) return null;
  for (const item of collection) {
    if (item?.type?.startsWith("image/")) {
      if (typeof item.getAsFile === "function") return item.getAsFile();
      return item;
    }
  }
  return null;
}

function validateImageFile(file) {
  if (!file) {
    setStatus("No image found.", "error");
    return false;
  }
  if (!file.type || !file.type.startsWith("image/")) {
    setStatus("Please use an image file.", "error");
    return false;
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    setStatus("Image is too large. Use a file under 10 MB.", "error");
    return false;
  }
  return true;
}

function isEditableElement(element) {
  return Boolean(
    element?.closest?.(
      'input:not([type="button"]):not([type="checkbox"]):not([type="color"]):not([type="file"]):not([type="radio"]):not([type="range"]), textarea, [contenteditable="true"]'
    )
  );
}

function extractImageUrlFromHtml(html) {
  if (!html) return "";
  try {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const image = doc.querySelector("img[src]");
    return image?.src || "";
  } catch {
    return "";
  }
}

function isLikelyWebUrl(value) {
  return /^https?:\/\//i.test((value || "").trim());
}

function loadBackgroundImageFile(file, sourceLabel = "Custom image") {
  if (!validateImageFile(file)) return;
  const uploadNonce = claimImageSelection();
  state.productImageAnalysis = null;
  const reader = new FileReader();
  reader.onload = async (ev) => {
    const img = new Image();
    img.onload = async () => {
      if (state.imageSelectionNonce !== uploadNonce) return;
      await ensureImageFocalPoint(img);
      state.mainImage = img;
      resetImageControls();
      editPanel.hidden = false;
      imagePanel.hidden = false;
      renderPoster();
      setStatus(`${sourceLabel} loaded!`, "success");
      bgImageUpload.value = "";
      analyzeUploadedProductImage(ev.target.result, uploadNonce);
    };
    img.src = ev.target.result;
  };
  reader.readAsDataURL(file);
}

async function loadBackgroundImageUrl(url, sourceLabel = "Pasted image") {
  const trimmedUrl = (url || "").trim();
  if (!isLikelyWebUrl(trimmedUrl)) {
    setStatus("Paste a direct image, an image URL, or drag in an image file.", "error");
    return false;
  }

  const uploadNonce = claimImageSelection();
  state.productImageAnalysis = null;

  try {
    setStatus("Loading pasted image...");
    const proxiedUrl = `/api/image?url=${encodeURIComponent(trimmedUrl)}`;
    const img = await imageFromUrl(proxiedUrl);
    if (state.imageSelectionNonce !== uploadNonce) return true;
    state.mainImage = img;
    resetImageControls();
    editPanel.hidden = false;
    imagePanel.hidden = false;
    renderPoster();
    setStatus(`${sourceLabel} loaded!`, "success");
    try {
      analyzeUploadedProductImage(proxiedUrl, uploadNonce);
    } catch (error) {
      console.warn("Pasted image analysis failed to start:", error);
    }
    return true;
  } catch (error) {
    console.warn("Pasted image URL load failed:", error);
    setStatus("That pasted link did not behave like a direct image.", "error");
    return false;
  }
}

async function loadClipboardImageData(clipboardData) {
  const file =
    getFirstImageFile(clipboardData?.items) ||
    getFirstImageFile(clipboardData?.files);
  if (file) {
    loadBackgroundImageFile(file, "Pasted image");
    return true;
  }

  const html = clipboardData?.getData?.("text/html") || "";
  const htmlImageUrl = extractImageUrlFromHtml(html);
  if (htmlImageUrl) {
    return loadBackgroundImageUrl(htmlImageUrl, "Pasted image");
  }

  const plainText = (clipboardData?.getData?.("text/plain") || "").trim();
  if (isLikelyWebUrl(plainText)) {
    return loadBackgroundImageUrl(plainText, "Pasted image");
  }

  return false;
}

async function loadBackgroundImageFromClipboard() {
  if (!navigator.clipboard?.read) {
    if (navigator.clipboard?.readText) {
      try {
        const text = await navigator.clipboard.readText();
        if (text && isLikelyWebUrl(text)) {
          await loadBackgroundImageUrl(text, "Clipboard image");
          return;
        }
      } catch (error) {
        console.warn("Clipboard text read failed:", error);
      }
    }
    setStatus("Clipboard paste button is not supported here. Use Ctrl+V or Cmd+V on the upload box.", "error");
    return;
  }

  try {
    const clipboardItems = await navigator.clipboard.read();
    for (const clipboardItem of clipboardItems) {
      const imageType = clipboardItem.types.find((type) => type.startsWith("image/"));
      if (imageType) {
        const blob = await clipboardItem.getType(imageType);
        const file = new File([blob], `clipboard-image.${imageType.split("/")[1] || "png"}`, { type: imageType });
        loadBackgroundImageFile(file, "Clipboard image");
        return;
      }
      if (clipboardItem.types.includes("text/html")) {
        const html = await (await clipboardItem.getType("text/html")).text();
        const imageUrl = extractImageUrlFromHtml(html);
        if (imageUrl && (await loadBackgroundImageUrl(imageUrl, "Clipboard image"))) return;
      }
      if (clipboardItem.types.includes("text/plain")) {
        const text = (await (await clipboardItem.getType("text/plain")).text()).trim();
        if (text && isLikelyWebUrl(text) && (await loadBackgroundImageUrl(text, "Clipboard image"))) return;
      }
    }
    setStatus("No image found in the clipboard.", "error");
  } catch (error) {
    console.warn("Clipboard image read failed:", error);
    setStatus("Clipboard access was blocked. Copy an image, then use Ctrl+V or Cmd+V on the upload box.", "error");
  }
}

bgImageUpload.addEventListener("change", (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  loadBackgroundImageFile(file);
});

if (bgPasteBtn) {
  bgPasteBtn.addEventListener("click", () => {
    loadBackgroundImageFromClipboard();
  });
}

if (bgUploadZone) {
  let dragDepth = 0;

  bgUploadZone.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      bgImageUpload.click();
    }
  });

  bgUploadZone.addEventListener("paste", (event) => {
    event.preventDefault();
    loadClipboardImageData(event.clipboardData).then((handled) => {
      if (!handled) setStatus("No image found in the clipboard.", "error");
    });
  });

  bgUploadZone.addEventListener("dragenter", (event) => {
    event.preventDefault();
    dragDepth += 1;
    bgUploadZone.classList.add("is-dragover");
  });

  bgUploadZone.addEventListener("dragover", (event) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    bgUploadZone.classList.add("is-dragover");
  });

  bgUploadZone.addEventListener("dragleave", (event) => {
    event.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth || event.target === bgUploadZone) {
      bgUploadZone.classList.remove("is-dragover");
    }
  });

  bgUploadZone.addEventListener("drop", (event) => {
    event.preventDefault();
    dragDepth = 0;
    bgUploadZone.classList.remove("is-dragover");
    const file = getFirstImageFile(event.dataTransfer?.files) || getFirstImageFile(event.dataTransfer?.items);
    if (!file) {
      setStatus("Drop an image file to use it as the background.", "error");
      return;
    }
    loadBackgroundImageFile(file, "Dropped image");
  });
}

document.addEventListener("paste", (event) => {
  const target = event.target;
  if (isEditableElement(target)) return;
  const zoneFocused =
    document.activeElement === bgUploadZone ||
    document.activeElement === bgPasteBtn ||
    bgUploadZone?.contains?.(document.activeElement);
  const pasteInsideZone = bgUploadZone?.contains?.(target);
  if (!zoneFocused && !pasteInsideZone) return;
  event.preventDefault();
  loadClipboardImageData(event.clipboardData).then((handled) => {
    if (!handled) setStatus("No image found in the clipboard.", "error");
  });
});

async function analyzeUploadedProductImage(imageData, expectedNonce) {
  try {
    setStatus("Reading product text and patterns...");
    const prepared = await prepareImageForAnalysis(imageData);
    if (state.imageSelectionNonce !== expectedNonce) return;

    const response = await fetch("/api/analyze-image", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ imageData: prepared }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "Image analysis failed.");
    if (state.imageSelectionNonce !== expectedNonce) return;

    state.productImageAnalysis = payload.analysis || null;
    const text = (state.productImageAnalysis?.visibleText || []).join(", ");
    setStatus(text ? `Product text recognized: ${text}` : "Product patterns recognized.", "success");
  } catch (error) {
    console.warn("Product image analysis failed:", error);
    if (state.imageSelectionNonce === expectedNonce) {
      setStatus("Custom image loaded. Product text recognition unavailable.", "success");
    }
  }
}

async function prepareImageForAnalysis(imageData) {
  const img = await createImage(imageData);
  const maxSide = 1200;
  const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
  const out = document.createElement("canvas");
  out.width = Math.max(1, Math.round(img.width * scale));
  out.height = Math.max(1, Math.round(img.height * scale));
  const outCtx = out.getContext("2d");
  outCtx.imageSmoothingEnabled = true;
  outCtx.imageSmoothingQuality = "high";
  outCtx.drawImage(img, 0, 0, out.width, out.height);
  return out.toDataURL("image/jpeg", 0.86);
}

/* ── Canvas drag-to-pan ── */

canvas.addEventListener("mousedown", (e) => {
  if (!state.mainImage) return;
  isDragging = true;
  canvas.classList.add("dragging");
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  dragStart = { x: e.clientX * scaleX, y: e.clientY * scaleY };
  dragOffsetStart = { ...state.imageOffset };
});

window.addEventListener("mousemove", (e) => {
  if (!isDragging) return;
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  const dx = e.clientX * scaleX - dragStart.x;
  const dy = e.clientY * scaleY - dragStart.y;
  state.imageOffset.x = clamp(dragOffsetStart.x + dx, -IMAGE_PAN_LIMIT, IMAGE_PAN_LIMIT);
  state.imageOffset.y = clamp(dragOffsetStart.y + dy, -IMAGE_PAN_LIMIT, IMAGE_PAN_LIMIT);
  imgOffsetX.value = Math.round(state.imageOffset.x);
  imgOffsetY.value = Math.round(state.imageOffset.y);
  renderPoster();
});

window.addEventListener("mouseup", () => {
  if (isDragging) {
    isDragging = false;
    canvas.classList.remove("dragging");
  }
});

// Touch support for mobile
canvas.addEventListener("touchstart", (e) => {
  if (!state.mainImage || e.touches.length !== 1) return;
  isDragging = true;
  const touch = e.touches[0];
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  dragStart = { x: touch.clientX * scaleX, y: touch.clientY * scaleY };
  dragOffsetStart = { ...state.imageOffset };
  e.preventDefault();
}, { passive: false });

canvas.addEventListener("touchmove", (e) => {
  if (!isDragging || e.touches.length !== 1) return;
  const touch = e.touches[0];
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  const dx = touch.clientX * scaleX - dragStart.x;
  const dy = touch.clientY * scaleY - dragStart.y;
  state.imageOffset.x = clamp(dragOffsetStart.x + dx, -IMAGE_PAN_LIMIT, IMAGE_PAN_LIMIT);
  state.imageOffset.y = clamp(dragOffsetStart.y + dy, -IMAGE_PAN_LIMIT, IMAGE_PAN_LIMIT);
  imgOffsetX.value = Math.round(state.imageOffset.x);
  imgOffsetY.value = Math.round(state.imageOffset.y);
  renderPoster();
  e.preventDefault();
}, { passive: false });

canvas.addEventListener("touchend", () => { isDragging = false; });

/* ── Scrape Flow ── */

async function runScrape() {
  const url = scrapeUrlInput.value.trim();
  if (!url) {
    setStatus("Enter an article URL first.", "error");
    return;
  }

  scrapeButton.disabled = true;
  scrapeButton.classList.add("loading");
  setStatus("Scraping article...");

  try {
    const response = await fetch("/api/scrape-article", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url })
    });

    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "Scrape failed.");
    }

    // Update state
    state.headline = payload.title || "";
    state.detailText = limitDetailTextClient(payload.detailText || payload.articleText || payload.title || "");
    // The scrape already extracted the full article body. Keep it: the AI
    // writer needs it to produce specific bullets, and without it the server
    // has to re-fetch the URL — a second request that often fails on
    // paywalled or JS-rendered pages, silently degrading to headline-only.
    state.articleText = payload.articleText || "";
    state.sourceUrl = payload.sourceUrl || scrapeUrlInput.value.trim();
    state.ready = true;

    // Reset offsets
    state.imageOffset = { x: 0, y: 0 };
    imgOffsetX.value = 0;
    imgOffsetY.value = 0;

    // Populate edit panel
    headlineEdit.value = payload.title || "";
    if (detailEdit) detailEdit.value = state.detailText;
    writeHeadline.value = payload.title || "";
    writeDetail.value = state.detailText;
    editPanel.hidden = false;
    imagePanel.hidden = false;
    scrollPreviewIntoViewIfMobile();
    closeSheetIfMobile();

    // Load scraped image
    if (payload.imageProxy) {
      setStatus("Loading image...");
      try {
        state.mainImage = await imageFromUrl(payload.imageProxy);
      } catch {
        state.mainImage = null;
        setStatus("Article scraped! Image could not load — using placeholder.", "success");
      }
    } else {
      state.mainImage = null;
    }

    renderPoster();
    setStatus(`Scraped — writing the article…`, "success");

    // Fetch recommended stock images in the background
    fetchStockImages(payload.title, { smartQuery: payload.imageQuery || "" });

    // One action, everything filled: scraping now also writes the headline,
    // the four points and the tweet, and pushes them into the slides. The
    // scrape is the moment we have the freshest source text, so this is
    // where grounding is best.
    generateArticle({ applyToSlides: true }).then((data) => {
      setStatus(
        data ? "Done! Poster and article ready — edit below, then download."
             : "Poster ready. The article writer failed — open the Article tab to retry.",
        data ? "success" : "error"
      );
    });
  } catch (error) {
    setStatus(error.message || "Unable to scrape that article.", "error");
  } finally {
    scrapeButton.disabled = false;
    scrapeButton.classList.remove("loading");
  }
}

async function fetchStockImages(headline, options = {}) {
  const { autoApplyFirst = false, autoApplyRandom = false, onStatus = null, smartQuery = "" } = options;
  const selectionNonceAtStart = state.imageSelectionNonce;
  const report = (message, type) => {
    if (typeof onStatus === "function") onStatus(message, type);
  };

  try {
    // 1. Preferred: the AI-generated entity query from the scrape (e.g.
    //    "Karan Johar Ranbir Kapoor Ramayana"). Fallback: naive keyword
    //    extraction from the headline (write-mode has no scrape payload).
    const STOP = new Set(["THE", "A", "AN", "AND", "OR", "BUT", "FOR", "WITH", "FROM", "THAT", "THIS",
      "WILL", "WOULD", "SHOULD", "COULD", "SAYS", "SAID", "AFTER", "BEFORE", "ABOUT",
      "HAVE", "HAS", "HAD", "WAS", "WERE", "ARE", "IS", "BEEN", "INTO", "OVER", "UNDER",
      "THEIR", "THEY", "THEM", "THERE", "THEN", "MORE", "MOST", "VERY", "JUST", "ALSO",
      "NEW", "NEWS", "LIVE", "WHAT", "WHEN", "WHERE", "WHO", "HOW", "WHY", "WHICH", "AMID", "IN", "ON"]);

    // Extract alphanumeric words, uppercase
    const words = headline.toUpperCase().replace(/[^A-Z0-9\s]/g, "").split(/\s+/).filter(Boolean);
    const keywords = words.filter(w => !STOP.has(w) && w.length > 2).slice(0, 5); // Take top 5 meaningful words

    let searchQuery = smartQuery
      || (keywords.length > 0 ? keywords.join(" ") : headline.slice(0, 40));
    if (smartQuery) console.log(`[images] using AI query: "${smartQuery}"`);
    const imageContext = buildProductImageContext(state.productImageAnalysis);
    const imageSearchTerms = buildProductSearchTerms(state.productImageAnalysis);
    if (imageSearchTerms) {
      searchQuery = `${searchQuery} ${imageSearchTerms}`.trim().slice(0, 120);
    }

    let images = [];

    // COST ORDER: free sources first. Flux (fal.ai) BILLS PER GENERATION, so
    // it only runs as the last resort when both free sources return nothing —
    // previously it fired first on every scrape and quietly burned credits.

    // 2. Web / News images (free: Bing -> Google -> DDG)
    try {
      const gRes = await fetch(`/api/google-images?query=${encodeURIComponent(searchQuery)}`);
      const gData = await gRes.json();
      if (gRes.ok && gData.images?.length) {
        images = gData.images;
      }
    } catch { /* Web images failed, try Stock Pexels */ }

    // 3. Pexels stock (free tier)
    if (!images.length) {
      try {
        const pRes = await fetch(`/api/stock-images?query=${encodeURIComponent(searchQuery)}`);
        const pData = await pRes.json();
        if (pRes.ok && pData.images?.length) {
          images = pData.images;
        }
      } catch { /* Pexels also failed */ }
    }

    // 4. Flux generation — PAID, last resort only.
    if (!images.length) {
      try {
        const fluxUrl = `/api/flux-image?query=${encodeURIComponent(searchQuery)}${imageContext ? `&context=${encodeURIComponent(imageContext)}` : ""}`;
        const fRes = await fetch(fluxUrl);
        const fData = await fRes.json();
        if (fRes.ok && fData.images?.length) {
          images = fData.images;
        }
      } catch { /* Flux failed too */ }
    }

    if (!images.length) {
      images = buildFallbackImageSuggestions(searchQuery);
    }

    if (!images.length) {
      stockImagesSection.hidden = true;
      report("No matching images found. You can upload one manually.", "error");
      return;
    }

    stockImagesGrid.innerHTML = "";
    const getLoadableImageUrls = (img) => {
      const urls = [img.imageProxy, img.image, img.preview].filter(Boolean);
      return [...new Set(urls)];
    };

    const applySuggestedImage = async (img, thumb = null, expectedNonce = null) => {
      if (expectedNonce !== null && state.imageSelectionNonce !== expectedNonce) {
        return false;
      }
      report("Loading selected image...");
      setStatus("Loading image...");
      for (const imageUrl of getLoadableImageUrls(img)) {
        try {
          const fullImg = await imageFromUrl(imageUrl);
          if (expectedNonce !== null && state.imageSelectionNonce !== expectedNonce) {
            return false;
          }
          await ensureImageFocalPoint(fullImg);
          claimImageSelection();
          state.mainImage = fullImg;
          resetImageControls();
          renderPoster();
          report("Image applied.", "success");
          setStatus("Image applied!", "success");
          stockImagesGrid.querySelectorAll(".stock-item").forEach(t => t.classList.remove("active"));
          if (thumb) thumb.classList.add("active");
          return true;
        } catch {
          // Keep trying the next available URL for this result.
        }
      }
      report("Failed to load that image.", "error");
      setStatus("Failed to load image.", "error");
      return false;
    };

    const thumbs = [];
    images.forEach(img => {
      const thumb = document.createElement("div");
      thumb.className = "stock-item";
      thumb.style.backgroundImage = `url(${img.preview})`;
      thumb.title = img.alt || "Related image";
      thumb.addEventListener("click", () => applySuggestedImage(img, thumb));
      stockImagesGrid.appendChild(thumb);
      thumbs.push(thumb);
    });

    stockImagesSection.hidden = false;
    report(`Found ${images.length} matching image${images.length === 1 ? "" : "s"}.`, "success");

    if ((autoApplyFirst || autoApplyRandom) && images[0] && state.imageSelectionNonce === selectionNonceAtStart) {
      const order = images.map((_, index) => index);
      if (autoApplyRandom) {
        for (let i = order.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [order[i], order[j]] = [order[j], order[i]];
        }
      }

      let applied = false;
      for (const index of order) {
        if (state.imageSelectionNonce !== selectionNonceAtStart) break;
        applied = await applySuggestedImage(images[index], thumbs[index], selectionNonceAtStart);
        if (applied) break;
      }

      if (applied) {
        report(`Poster ready with a matching image. ${images.length > 1 ? "Tap another thumbnail to change it." : ""}`.trim(), "success");
      } else if (state.imageSelectionNonce === selectionNonceAtStart) {
        report("Found images, but none loaded. Try a thumbnail or upload one manually.", "error");
      }
    }
  } catch {
    stockImagesSection.hidden = true;
    report("Image search failed. You can upload one manually.", "error");
  }
}

/* ── Poster Rendering ── */

// Compute the headline layout (lines + font) AND its top y position based on
// canvas.height - bottomPadding. Done once per render and stashed on state
// so drawBackground / drawTag / drawHeadline all use the same anchor.
function buildProductSearchTerms(analysis) {
  if (!analysis) return "";
  return [
    analysis.productType,
    ...(analysis.visibleText || []).slice(0, 3),
    ...(analysis.brandCues || []).slice(0, 2),
  ]
    .filter(Boolean)
    .join(" ")
    .replace(/[^\w\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

function buildProductImageContext(analysis) {
  if (!analysis) return "";
  const parts = [];
  if (analysis.productType) parts.push(`product type: ${analysis.productType}`);
  if (analysis.visibleText?.length) parts.push(`visible text/OCR: ${analysis.visibleText.join(", ")}`);
  if (analysis.brandCues?.length) parts.push(`brand cues: ${analysis.brandCues.join(", ")}`);
  if (analysis.patterns?.length) parts.push(`patterns: ${analysis.patterns.join(", ")}`);
  if (analysis.colors?.length) parts.push(`colors: ${analysis.colors.join(", ")}`);
  if (analysis.promptHints) parts.push(`prompt hints: ${analysis.promptHints}`);
  return parts.join("; ").slice(0, 900);
}

function computeHeadlineLayoutAndTop() {
  const L = getLayout();
  const text = state.headline || "YOUR HEADLINE HERE";
  const layout = state.fontSize > 0
    ? buildHeadlineLayoutFixed(text, L.headline.maxWidth, state.fontSize)
    : buildHeadlineLayout(text, L.headline.maxWidth, 5);

  // Pull the actual font size out of the font string so the block height
  // doesn't depend on layout.lineHeight (which has line-spacing baked in)
  const m = layout.font.match(/(\d+(?:\.\d+)?)px/);
  const fontSize = m ? parseFloat(m[1]) : 49;

  const blockHeight = (layout.lines.length - 1) * layout.lineHeight + fontSize;
  const bottomPadding = isXRenderMode()
    ? 56
    : L.headline.bottomPadding;
  const top = Math.max(0, canvas.height - bottomPadding - blockHeight);
  return { layout, top, fontSize, blockHeight, bottomPadding };
}

/* ── Three cards, one renderer ──
   The reader swipes a carousel, so the editor shows all three slides at once
   instead of hiding two behind a mode toggle. Every draw function reads the
   module-level `ctx` and `canvas`, so each card is painted by pointing `ctx`
   at that card's canvas and setting the mode — the same swap trick the
   high-res exporter already uses. No draw function needed changing.

   `state._targetedRender` marks "paint once into the ctx I gave you", which
   is what the exporter and the per-card painters need; without it a nested
   renderPoster() would recurse back into painting all three. */
const PREVIEW_CARDS = [
  { mode: "pix",   canvas: document.getElementById("post-canvas") },
  { mode: "text",  canvas: document.getElementById("text-canvas") },
  { mode: "video", canvas: document.getElementById("video-canvas") },
  { mode: "x",     canvas: document.getElementById("x-canvas") },
];

function paintCardInto(target, mode) {
  if (!target) return;
  if (target.width !== canvas.width || target.height !== canvas.height) {
    target.width = canvas.width;
    target.height = canvas.height;
  }
  const prevCtx = ctx;
  const prevMode = state.previewMode;
  const prevTargeted = state._targetedRender;
  ctx = target.getContext("2d");
  state.previewMode = mode;
  state._targetedRender = true;
  try {
    paintPoster();
  } finally {
    ctx = prevCtx;
    state.previewMode = prevMode;
    state._targetedRender = prevTargeted;
  }
}

function renderPoster() {
  // Export paths swap ctx themselves and want a single paint.
  if (state._targetedRender) { paintPoster(); return; }
  for (const card of PREVIEW_CARDS) paintCardInto(card.canvas, card.mode);
}

function paintPoster() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";

  if (isVideoPreviewMode()) {
    drawPixVideoScreen();
    return;
  }

  if (isTextPreviewMode()) {
    drawPixTextScreen();
    return;
  }

  // Compute headline layout + bottom-anchored top ONCE for this render and
  // share via state._render so drawBackground / drawTag / drawHeadline don't
  // each have to recompute the same thing.
  state._render = computeHeadlineLayoutAndTop();

  drawBackground();
  drawHero();
  drawTag();
  drawHeadline();
  drawHeadlineTimestamp();

  // Preview-only UI elements (not included in download).
  // Only the 9:16 preset shows the Reels-style engagement + nav bars; on
  // square / wide / 4:5 ratios these mockups don't make visual sense.
  if (!state.isDownloading && !isXRenderMode() && getLayout().showPreviewBars) {
    drawEngagementBar();
    drawNavBar();
  }

  // AI Enhance is only meaningful once a real background image is loaded
  const enhanceBtn = document.getElementById("ai-enhance-btn");
  if (enhanceBtn && !enhanceBtn.classList.contains("working")) {
    enhanceBtn.disabled = !state.mainImage;
  }
  // Same rule for "Copy image for upscaling" — nothing to copy without one.
  const copySrcBtn = document.getElementById("copy-source-btn");
  if (copySrcBtn && !copySrcBtn.classList.contains("working")) {
    copySrcBtn.disabled = !state.mainImage;
  }
}

/**
 * Slide 2, video variant: the clip fills the frame with the Shortly/Pix
 * branding over it.
 *
 * This same function produces BOTH the on-screen preview and the transparent
 * PNG that ffmpeg burns into the exported MP4 — see renderVideoOverlayPng().
 * Sharing one renderer is the whole point: the branding in the file is
 * guaranteed to be what the user approved on screen, and the media service
 * never needs a font, a layout table, or a redeploy when the design changes.
 *
 * In overlay-export mode the video frame and the mockup chrome are skipped,
 * leaving gradient + logo on transparency.
 */
function drawPixVideoScreen() {
  const W = canvas.width;
  const H = canvas.height;
  const L = getLayout();
  const s = Math.min(W / 920, H / 1700);
  const overlayOnly = !!state.videoOverlayExport;

  ctx.save();

  if (!overlayOnly) {
    // Letterbox backdrop, then the current video frame scaled to cover.
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, W, H);
    const v = state.videoEl;
    if (v && v.readyState >= 2 && v.videoWidth > 0) {
      const scale = Math.max(W / v.videoWidth, H / v.videoHeight);
      const dw = v.videoWidth * scale;
      const dh = v.videoHeight * scale;
      // focus 0.5 is centred; 0 pins the left/top edge, 1 the right/bottom.
      // Only the overflowing axis can move, so the frame never shows letterbox.
      const f = state.videoFocus || { x: 0.5, y: 0.5 };
      ctx.drawImage(v, -(dw - W) * f.x, -(dh - H) * f.y, dw, dh);
    }
  }

  // Bottom scrim so the logo and any platform UI stay legible over bright
  // footage. Lighter than the poster's gradient — the video is the subject
  // here, not a backdrop for a headline.
  const opa = (state.overlayOpacity ?? 100) / 100;
  const fade = Math.min(H * 0.42, L.gradient.fadeHeight * 1.5);
  const grad = ctx.createLinearGradient(0, H - fade, 0, H);
  grad.addColorStop(0, "rgba(0,0,0,0)");
  grad.addColorStop(0.55, `rgba(0,0,0,${(0.34 * opa).toFixed(2)})`);
  grad.addColorStop(1, `rgba(0,0,0,${(0.72 * opa).toFixed(2)})`);
  ctx.fillStyle = grad;
  ctx.fillRect(0, H - fade, W, fade);

  // A matching top scrim keeps the logo readable on light footage.
  const topFade = H * 0.18;
  const topGrad = ctx.createLinearGradient(0, 0, 0, topFade);
  topGrad.addColorStop(0, `rgba(0,0,0,${(0.46 * opa).toFixed(2)})`);
  topGrad.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = topGrad;
  ctx.fillRect(0, 0, W, topFade);

  drawFixedLogos();
  drawVideoCaption();

  // Mockup chrome is preview-only — it must never reach the exported file.
  if (!overlayOnly && !state.isDownloading && getLayout().showPreviewBars) {
    drawEngagementBar();
    drawPixPageDots(0.5 * W, 1558 * (H / 1700), s);
    drawNavBar();
  }

  ctx.restore();
}

/**
 * Caption burned into the video slide, bottom-anchored like the poster
 * headline. Supports the same [bracket] / (paren) / {brace} highlight
 * syntax as the headline, so the two slides look like one system.
 *
 * Drawn inside drawPixVideoScreen, which means it lands in BOTH the live
 * preview and the transparent PNG ffmpeg composites — no server change was
 * needed to add this.
 *
 * Bottom padding matches the headline preset, which is already tuned to sit
 * above the platform's own UI (the engagement/nav bars the preview mocks up).
 */
function drawVideoCaption() {
  const raw = (state.videoCaption || "").trim();
  if (!raw) return;

  const W = canvas.width;
  const H = canvas.height;
  const L = getLayout();
  const s = Math.min(W / 920, H / 1700);

  const maxWidth = L.headline.maxWidth;
  const left = L.headline.x;
  const fontSize = Math.round((state.videoCaptionSize || 40) * s);
  const lineHeight = Math.round(fontSize * 1.32);
  const font = `${PREVIEW_TEXT_WEIGHT} ${fontSize}px ${PREVIEW_TEXT_FONT}`;

  ctx.save();
  ctx.font = font;
  ctx.textAlign = "left";
  ctx.textBaseline = "top";

  // Wrap on the visible text — bracket characters are markup, not glyphs, so
  // measuring with them in would wrap too early. Newlines are honoured as
  // deliberate breaks: each segment wraps on its own.
  const lines = [];
  for (const segment of raw.replace(/\r\n?/g, "\n").split("\n")) {
    const words = segment.trim().split(/\s+/).filter(Boolean);
    if (!words.length) { lines.push(""); continue; }
    let line = "";
    for (const word of words) {
      const test = line ? `${line} ${word}` : word;
      if (!line || ctx.measureText(test.replace(HIGHLIGHT_ANY_CHARS_GLOBAL, "")).width <= maxWidth) {
        line = test;
      } else {
        lines.push(line);
        line = word;
      }
    }
    if (line) lines.push(line);
  }

  const MAX_LINES = 4;
  if (lines.length > MAX_LINES) {
    lines.length = MAX_LINES;
    lines[MAX_LINES - 1] = `${lines[MAX_LINES - 1].replace(/[\s.,;:]+$/, "")}…`;
  }

  const blockHeight = lines.length * lineHeight;
  const top = H - L.headline.bottomPadding * (H / 1700) - blockHeight;

  // Pass 1 — accent boxes behind highlighted runs.
  let highlighted = false;
  lines.forEach((text, i) => {
    const y = top + i * lineHeight;
    let cursor = left;
    let segStart = null;
    let segWidth = 0;
    const segments = [];
    const parts = text.split(" ");

    parts.forEach((rawWord, idx) => {
      const opening = HIGHLIGHT_OPEN_CHAR.test(rawWord);
      const closing = HIGHLIGHT_CLOSE_CHAR.test(rawWord);
      const clean = rawWord.replace(HIGHLIGHT_ANY_CHARS_GLOBAL, "");
      if (opening) highlighted = true;

      const wordWidth = ctx.measureText(clean).width;
      const advance = wordWidth + ctx.measureText(" ").width;

      if (highlighted && clean.length) {
        if (segStart === null) segStart = cursor;
        segWidth += (closing || idx === parts.length - 1) ? wordWidth : advance;
      }
      if ((closing || idx === parts.length - 1) && segStart !== null) {
        segments.push({ x: segStart, w: segWidth });
        segStart = null;
        segWidth = 0;
      }
      if (closing) highlighted = false;
      cursor += advance;
    });

    ctx.fillStyle = state.accent;
    const padX = fontSize * 0.16;
    const padY = fontSize * 0.14;
    segments.forEach(seg => {
      const r = fontSize * 0.18;
      const bx = seg.x - padX;
      const by = y - padY;
      const bw = seg.w + padX * 2;
      const bh = fontSize + padY * 2;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(bx, by, bw, bh, r);
      else ctx.rect(bx, by, bw, bh);
      ctx.fill();
    });
  });

  // Pass 2 — the words themselves.
  ctx.fillStyle = "#ffffff";
  ctx.shadowColor = "rgba(0, 0, 0, 0.55)";
  ctx.shadowBlur = 16 * s;
  ctx.shadowOffsetY = 5 * s;
  lines.forEach((text, i) => {
    ctx.fillText(text.replace(HIGHLIGHT_ANY_CHARS_GLOBAL, ""), left, top + i * lineHeight);
  });

  ctx.restore();
}

/**
 * Render the video branding to a transparent PNG blob at exactly
 * `width`×`height` — the dimensions ffmpeg will scale the clip to, so the
 * overlay lands pixel-for-pixel with no resampling drift.
 */
async function renderVideoOverlayPng(width, height) {
  const out = document.createElement("canvas");
  out.width = width;
  out.height = height;
  const outCtx = out.getContext("2d");
  outCtx.imageSmoothingEnabled = true;
  outCtx.imageSmoothingQuality = "high";
  // Design-space → output-space. The canvas preset drives layout, so this is
  // a uniform scale by construction and the overlay can't skew.
  outCtx.scale(width / canvas.width, height / canvas.height);

  const prevCtx = ctx;
  const prevMode = state.previewMode;
  const prevTargeted = state._targetedRender;
  ctx = outCtx;
  state.videoOverlayExport = true;
  state.previewMode = "video";
  state._targetedRender = true;
  try {
    drawPixVideoScreen();
  } finally {
    ctx = prevCtx;
    state.videoOverlayExport = false;
    state.previewMode = prevMode;
    state._targetedRender = prevTargeted;
  }

  return new Promise((resolve) => {
    try { out.toBlob(resolve, "image/png"); } catch { resolve(null); }
  });
}

/**
 * Output size for the exported MP4. Width is pinned to 1080 (the practical
 * ceiling for Reels/Stories/Shorts) and height follows the CANVAS aspect,
 * not a nominal 9:16 — the "9:16" preset is really 920×1700 (0.541), so
 * assuming true 9:16 here would misalign the overlay by ~90px.
 * Both dimensions are forced even; libx264 + yuv420p requires it.
 */
function videoTargetSize() {
  const even = (n) => Math.max(2, Math.round(n / 2) * 2);
  // The overlay is drawn, not resampled, so targeting a larger frame than the
  // design canvas costs nothing in quality. Portrait and square go to 1080
  // wide (the Reels/Stories/Shorts standard); landscape goes to 1920.
  const width = even(canvas.width > canvas.height ? 1920 : 1080);
  const height = even(width * (canvas.height / canvas.width));
  return { width, height };
}

/* ── Preview repaint loop ──
   A <video> gives the canvas no "new frame" signal, so during playback we
   repaint every animation frame. It runs ONLY while the clip is actually
   playing — a paused video produces identical frames, and looping on those
   would burn a core for nothing. Seeks and loads repaint once instead
   (see the listeners further down). */
let videoPreviewRaf = 0;

function startVideoPreviewLoop() {
  if (videoPreviewRaf) return;
  const tick = () => {
    const v = state.videoEl;
    // Park as soon as the mode changes or playback stops.
    if (!v || v.paused || v.ended) {
      videoPreviewRaf = 0;
      renderPoster();   // settle on the final frame
      return;
    }
    renderPoster();
    videoPreviewRaf = requestAnimationFrame(tick);
  };
  videoPreviewRaf = requestAnimationFrame(tick);
}

function stopVideoPreviewLoop() {
  if (videoPreviewRaf) cancelAnimationFrame(videoPreviewRaf);
  videoPreviewRaf = 0;
}

function drawPixTextScreen() {
  const image = state.mainImage || defaultMain;
  const W = canvas.width;
  const H = canvas.height;
  const L = getLayout();
  const s = Math.min(W / 920, H / 1700);

  ctx.save();
  ctx.fillStyle = "#070707";
  ctx.fillRect(0, 0, W, H);

  drawTextPreviewBackgroundImage(image, 0, 0, W, H, state.imageOffset, (state.imageZoom || 100) / 100, s);

  const dim = ctx.createLinearGradient(0, 0, 0, H);
  dim.addColorStop(0, "rgba(0, 0, 0, 0.68)");
  dim.addColorStop(0.34, "rgba(0, 0, 0, 0.52)");
  dim.addColorStop(0.62, "rgba(0, 0, 0, 0.68)");
  dim.addColorStop(1, "rgba(0, 0, 0, 0.98)");
  ctx.fillStyle = dim;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "rgba(0, 0, 0, 0.22)";
  ctx.fillRect(0, 0, W, H);

  drawFixedLogos();

  const textX = L.headline.x;
  const minTextY = state.forceTextExport ? H * 0.16 : H * 0.1;
  const bottomTextPadding = state.forceTextExport ? L.headline.bottomPadding : 335;
  const lastLineY = H - bottomTextPadding * (H / 1700);
  drawWrappedPreviewText(getDetailTextForPreview(), textX, minTextY, L.headline.maxWidth, lastLineY, 39 * s, 61 * s);

  if (!state.forceTextExport) {
    drawEngagementBar();
    drawPixPageDots(0.5 * W, 1558 * (H / 1700), s);
    drawNavBar();
  }

  ctx.restore();
}

/**
 * Creation timestamp under the slide-2 paragraph — "07 Aug | 12:30 PM".
 *
 * Left edge aligns with the paragraph (same textX) so the two form one
 * block rather than two loosely stacked things. Sits one paragraph-line
 * below the last line of copy.
 *
 * Spec was Poppins / 70% opacity / 10px. The 10 is a Figma-frame value and
 * frames differ in width, so it is expressed here relative to the 39px
 * paragraph and scaled with the canvas — that keeps the proportion in the
 * reference at every aspect ratio. TIMESTAMP_SIZE is the one number to
 * change if it should read larger or smaller.
 */
const TIMESTAMP_SIZE = 17;      // design px, against a 39px paragraph
const TIMESTAMP_OPACITY = 0.7;

/**
 * Date only — "07 Aug". No time.
 *
 * toLocaleDateString with no `timeZone` option resolves in the runtime's own
 * zone, which is the browser's, which follows the operating system. So the
 * date is whatever the person looking at the screen would call today, with
 * no conversion and nothing to configure.
 *
 * This matters more than it looks: a UTC-based date is wrong for a third of
 * every day in IST (UTC+5:30) — anything created before 05:30 local would
 * carry yesterday's date.
 */
function formatCreatedAt(date) {
  // Reads the clock at paint time. This used to render a Date frozen when the
  // page loaded, which is wrong for the way the app is actually used: the tab
  // stays open for days, so the stamp would sit on yesterday's date — or last
  // week's — without anyone noticing.
  const d = date instanceof Date && !isNaN(date) ? date : new Date();
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
}

/**
 * Place the stamp directly beneath the poster headline.
 *
 * The headline is bottom-anchored and its block height changes with the line
 * count, so the position is derived from the cached layout rather than a
 * fixed y — otherwise a two-line headline would leave a gap and a four-line
 * one would collide.
 */
function drawHeadlineTimestamp() {
  if (!state.showTimestamp) return;
  const L = getLayout();
  const cached = state._render || computeHeadlineLayoutAndTop();
  const s = Math.min(canvas.width / 920, canvas.height / 1700);
  // Sit just under the last headline line, left edge shared with it.
  const y = cached.top + cached.blockHeight + Math.round(14 * s);
  drawTimestamp(L.headline.x, y, s);
}

function drawTimestamp(x, y, s) {
  if (!state.showTimestamp) return;
  ctx.save();
  ctx.globalAlpha = TIMESTAMP_OPACITY;
  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  // Poppins regular (400). PREVIEW_TEXT_FONT already resolves to Poppins;
  // only the weight differs from the paragraph, which sits at 700.
  ctx.font = `400 ${Math.round(TIMESTAMP_SIZE * s)}px ${PREVIEW_TEXT_FONT}`;
  // A soft shadow only — at 70% over a blurred photo the glyphs would
  // otherwise disappear against light areas.
  ctx.shadowColor = "rgba(0, 0, 0, 0.5)";
  ctx.shadowBlur = 10 * s;
  ctx.shadowOffsetY = 2 * s;
  ctx.fillText(formatCreatedAt(state.createdAt), x, y);
  ctx.restore();
}

function drawTextPreviewBackgroundImage(image, x, y, width, height, offset, zoom, scale = 1) {
  const bleed = 34 * scale;
  const drawX = x - bleed;
  const drawY = y - bleed;
  const drawW = width + bleed * 2;
  const drawH = height + bleed * 2;
  const baseScale = Math.max(drawW / image.width, drawH / image.height);
  const imageScale = baseScale * (zoom || 1) * IMAGE_PAN_HEADROOM;
  const drawWidth = image.width * imageScale;
  const drawHeight = image.height * imageScale;
  const focal = image.__focalPoint || { x: image.width / 2, y: image.height / 2 };

  ctx.save();
  ctx.filter = `blur(${Math.round(18 * scale)}px) brightness(62%) contrast(108%) saturate(72%)`;
  drawBlurredCoverLayer(null);
  drawBlurredCoverLayer(offset);
  ctx.restore();

  function drawBlurredCoverLayer(layerOffset) {
    let dx = drawX + drawW / 2 - focal.x * imageScale;
    let dy = drawY + drawH / 2 - focal.y * imageScale;

    if (layerOffset) {
      dx += layerOffset.x;
      dy += layerOffset.y;
    }

    const minX = drawX + drawW - drawWidth;
    const minY = drawY + drawH - drawHeight;
    dx = clamp(dx, minX, drawX);
    dy = clamp(dy, minY, drawY);
    ctx.drawImage(image, dx, dy, drawWidth, drawHeight);
  }
}

function drawTextPreviewLogo(x, y, size) {
  const logo = state.logoImage || state.shortlyLogoImage;
  if (!logo) return;

  const rawW = logo.naturalWidth || logo.width || 1;
  const rawH = logo.naturalHeight || logo.height || 1;
  const scale = size / Math.max(rawW, rawH);
  const drawW = rawW * scale;
  const drawH = rawH * scale;
  drawLogoAt(logo, x, y, drawW, drawH, { glow: logo === state.logoImage });
}

function drawPixStatusBar(scaleX, scaleY, s) {
  ctx.save();
  ctx.fillStyle = "#ffffff";
  ctx.font = `700 ${Math.round(29 * s)}px 'Inter', 'Segoe UI', Arial, sans-serif`;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText("9:41", 104 * scaleX, 45 * scaleY);

  const right = canvas.width - 72 * scaleX;
  const y = 45 * scaleY;

  ctx.strokeStyle = "#ffffff";
  ctx.fillStyle = "#ffffff";
  ctx.lineWidth = 4 * s;
  for (let i = 0; i < 4; i += 1) {
    const h = (9 + i * 6) * s;
    ctx.fillRect(right - 140 * scaleX + i * 14 * scaleX, y + 17 * scaleY - h, 7 * scaleX, h);
  }

  ctx.beginPath();
  ctx.arc(right - 70 * scaleX, y + 6 * scaleY, 30 * s, Math.PI * 1.18, Math.PI * 1.82);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(right - 70 * scaleX, y + 6 * scaleY, 18 * s, Math.PI * 1.18, Math.PI * 1.82);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(right - 70 * scaleX, y + 8 * scaleY, 4 * s, 0, Math.PI * 2);
  ctx.fill();

  const bx = right - 18 * scaleX;
  const by = y - 14 * scaleY;
  const bw = 52 * scaleX;
  const bh = 25 * scaleY;
  ctx.lineWidth = 3 * s;
  ctx.strokeStyle = "rgba(255, 255, 255, 0.92)";
  ctx.beginPath();
  ctx.roundRect(bx, by, bw, bh, 6 * s);
  ctx.stroke();
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(bx + bw + 4 * scaleX, by + 8 * scaleY, 4 * scaleX, 9 * scaleY);
  ctx.beginPath();
  ctx.roundRect(bx + 5 * scaleX, by + 5 * scaleY, bw - 10 * scaleX, bh - 10 * scaleY, 4 * s);
  ctx.fill();
  ctx.restore();
}

function drawWrappedPreviewText(text, x, minY, maxWidth, maxY, fontSize, lineHeight) {
  ctx.save();
  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.shadowColor = "rgba(0, 0, 0, 0.48)";
  ctx.shadowBlur = 14;
  ctx.shadowOffsetY = 5;

  const preserveOpenBullet = !state.isDownloading && state.previewMode === "text";
  const fit = fitPreviewTextLines(text, maxWidth, minY, maxY, fontSize, lineHeight, { preserveOpenBullet });
  const { lines, visibleLines } = fit;
  const overflowed = lines.length > visibleLines.length;
  let ellipsisIndex = -1;
  if (overflowed) {
    ellipsisIndex = visibleLines.length - 1;
    while (ellipsisIndex > 0 && !visibleLines[ellipsisIndex]) ellipsisIndex -= 1;
    visibleLines[ellipsisIndex] = `${visibleLines[ellipsisIndex]}...`;
  }

  ctx.font = `${PREVIEW_TEXT_WEIGHT} ${Math.round(fit.fontSize)}px ${PREVIEW_TEXT_FONT}`;
  const visibleHeight = visibleLines.reduce((sum, line) => sum + getPreviewTextStep(line, fit.lineHeight), 0);
  const startY = Math.max(minY, maxY - Math.max(0, visibleHeight - fit.lineHeight));
  let cy = startY;
  visibleLines.forEach((visibleLine, index) => {
    if (visibleLine) {
      if (index === ellipsisIndex) {
        drawEllipsizedLine(visibleLine, x, cy, maxWidth);
      } else {
        ctx.fillText(visibleLine, x, cy);
      }
    }
    cy += getPreviewTextStep(visibleLine, fit.lineHeight);
  });
  ctx.restore();
}

function fitPreviewTextLines(text, maxWidth, minY, maxY, fontSize, lineHeight, options = {}) {
  const canShrink = state.previewMode === "text";
  const scales = canShrink ? [1, 0.92, 0.84, 0.76, 0.68, 0.62] : [1];
  let bestFit = null;

  for (const scale of scales) {
    const nextFontSize = Math.max(fontSize * scale, fontSize * 0.62);
    const nextLineHeight = Math.max(nextFontSize * 1.34, lineHeight * scale);
    ctx.font = `${PREVIEW_TEXT_WEIGHT} ${Math.round(nextFontSize)}px ${PREVIEW_TEXT_FONT}`;
    const lines = buildPreviewTextLines(text, maxWidth, options);
    const maxBlockHeight = Math.max(nextLineHeight, maxY - minY + nextLineHeight);
    const visibleLines = getVisiblePreviewLines(lines, nextLineHeight, maxBlockHeight);
    const fit = { fontSize: nextFontSize, lineHeight: nextLineHeight, lines, visibleLines };
    bestFit = fit;
    if (visibleLines.length === lines.length) return fit;
  }

  return bestFit;
}

function getVisiblePreviewLines(lines, lineHeight, maxBlockHeight) {
  const visibleLines = [];
  let blockHeight = 0;
  for (const line of lines) {
    const step = getPreviewTextStep(line, lineHeight);
    if (visibleLines.length && blockHeight + step > maxBlockHeight) break;
    visibleLines.push(line);
    blockHeight += step;
  }
  return visibleLines.length ? visibleLines : [lines[0] || ""];
}

function getPreviewTextStep(line, lineHeight) {
  return line ? lineHeight : lineHeight * (state.previewMode === "text" ? 0.28 : 0.42);
}

function buildPreviewTextLines(text, maxWidth, options = {}) {
  const sourceLines = limitDetailTextClient(text, options).split("\n");
  const lines = [];
  sourceLines.forEach((sourceLine) => {
    const trimmed = sourceLine.trim();
    if (!trimmed) {
      if (lines.length && lines[lines.length - 1] !== "") lines.push("");
      return;
    }

    const lineText = /^[\u2022*-]\s+/.test(trimmed) ? `\u2022 ${trimmed.replace(/^[\u2022*-]\s+/, "")}` : trimmed;
    lines.push(...wrapPreviewTextLine(lineText, maxWidth));
  });

  return lines.length ? lines : [""];
}

function wrapPreviewTextLine(text, maxWidth) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  words.forEach((word) => {
    const test = line ? `${line} ${word}` : word;
    if (!line || ctx.measureText(test).width <= maxWidth) {
      line = test;
      return;
    }

    lines.push(line);
    line = word;
  });

  if (line) lines.push(line);
  return lines;
}

function drawEllipsizedLine(line, x, y, maxWidth) {
  let output = line.endsWith("...") ? line : `${line}...`;
  while (output.length > 4 && ctx.measureText(output).width > maxWidth) {
    output = `${output.slice(0, -4).trimEnd()}...`;
  }
  ctx.fillText(output, x, y);
}

function drawPixPageDots(cx, cy, s) {
  ctx.save();
  ctx.fillStyle = "rgba(255, 255, 255, 0.24)";
  ctx.beginPath();
  ctx.arc(cx - 11 * s, cy, 7 * s, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.arc(cx + 11 * s, cy, 7 * s, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawBackground() {
  ctx.fillStyle = "#050505";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const glow = ctx.createRadialGradient(110, 90, 0, 110, 90, 350);
  glow.addColorStop(0, "rgba(139, 92, 246, 0.24)");
  glow.addColorStop(1, "rgba(139, 92, 246, 0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
}

function drawHero() {
  const image = state.mainImage || defaultMain;
  const zoom = (state.imageZoom || 100) / 100;
  drawCoverImage(image, 0, 0, canvas.width, canvas.height, state.imageOffset, zoom);

  // Overlay opacity (0-100)
  const opa = (state.overlayOpacity ?? 100) / 100;

  // Smooth gradient — starts `fadeHeight` px above the headline top and
  // fades to fully black BY the headline top, then stays black down to
  // canvas.height. headline top is computed dynamically from line count,
  // so the gradient automatically follows long vs short headlines.
  const L = getLayout();
  const headlineTop = state._render?.top ?? (canvas.height - L.headline.bottomPadding - 200);
  const fullBlackY = headlineTop;
  const gradientStart = Math.max(0, fullBlackY - L.gradient.fadeHeight);
  const gradientHeight = canvas.height - gradientStart;
  const fullBlackFrac = (fullBlackY - gradientStart) / gradientHeight;
  const grad = ctx.createLinearGradient(0, gradientStart, 0, canvas.height);
  // Stops are placed proportionally between gradientStart and fullBlackY.
  // The original 9:16 stops (.12,.22,.30,.38,.44,.50 of 350px range) become:
  //   t=0 → transparent, t=fullBlackFrac → fully black
  const stop = (frac, alpha) =>
    grad.addColorStop(Math.min(1, frac * fullBlackFrac), `rgba(0,0,0,${(alpha * opa).toFixed(2)})`);
  grad.addColorStop(0, "rgba(0,0,0,0)");
  stop(0.24, 0.10);
  stop(0.44, 0.30);
  stop(0.60, 0.55);
  stop(0.76, 0.80);
  stop(0.88, 0.95);
  stop(1.00, 1.00);
  grad.addColorStop(1, `rgba(0,0,0,${(1 * opa).toFixed(2)})`);
  ctx.fillStyle = grad;
  ctx.fillRect(0, gradientStart, canvas.width, gradientHeight);

  // Draw both logos at fixed positions
  drawFixedLogos();
}

function drawLogo(x, y, size) {
  ctx.save();

  if (state.logoImage) {
    // Draw logo PNG at its native aspect ratio
    const imgW = state.logoImage.naturalWidth || state.logoImage.width;
    const imgH = state.logoImage.naturalHeight || state.logoImage.height;
    const aspect = imgW / imgH;
    let drawW, drawH;
    if (aspect >= 1) {
      drawW = size;
      drawH = size / aspect;
    } else {
      drawH = size;
      drawW = size * aspect;
    }
    ctx.shadowColor = "rgba(0,0,0,0.4)";
    ctx.shadowBlur = 18;
    ctx.drawImage(
      state.logoImage,
      x - drawW / 2,
      y - drawH / 2,
      drawW,
      drawH
    );
    ctx.shadowBlur = 0;
  } else {
    // Text fallback
    ctx.beginPath();
    ctx.arc(x, y, size / 2, 0, Math.PI * 2);
    ctx.closePath();
    ctx.fillStyle = "#ffffff";
    ctx.shadowColor = "rgba(0,0,0,0.35)";
    ctx.shadowBlur = 24;
    ctx.fill();
    ctx.shadowBlur = 0;

    ctx.fillStyle = state.accent;
    ctx.font = `italic 800 ${Math.round(size * 0.42)}px 'Poppins', 'Segoe UI', Arial, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("Pix", x, y + 2);
  }

  ctx.restore();
}

function drawFixedLogos() {
  // Pick logo: when exporting for X, swap to Shortly (if loaded). Else use Pix.
  const useAlt = isXRenderMode() && state.shortlyLogoImage;
  const logo = useAlt ? state.shortlyLogoImage : state.logoImage;
  if (!logo) return;

  // Position + size come from the active aspect-ratio preset. The Shortly
  // logo already has its own gradient halo, so we use the slot size that's
  // tuned for it (slightly larger), and skip the white glow.
  const L = getLayout();
  const slotSize = useAlt ? L.logo.slotShortly : L.logo.slotPix;
  const centerX = L.logo.centerX;
  const centerY = L.logo.centerY;

  const rawW = logo.naturalWidth  || logo.width  || 1;
  const rawH = logo.naturalHeight || logo.height || 1;

  // Scale so the longest edge fills the slot (preserves aspect ratio)
  const scale = slotSize / Math.max(rawW, rawH);
  const drawW = rawW * scale;
  const drawH = rawH * scale;

  // Center inside the slot
  const px = centerX - drawW / 2;
  const py = centerY - drawH / 2;

  drawLogoAt(logo, px, py, drawW, drawH, { glow: !useAlt });
}

function drawLogoAt(img, x, y, w, h, { glow = true } = {}) {
  const cx = x + w / 2;
  const cy = y + h / 2;
  const radius = Math.min(w, h) / 2;

  ctx.save();
  if (glow) {
    // Soft white halo to make the Pix logo pop against dark backgrounds.
    // Skipped for the Shortly logo, which carries its own gradient circle.
    ctx.shadowColor = "rgba(255, 255, 255, 0.5)";
    ctx.shadowBlur = 18;
  }

  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();

  ctx.drawImage(img, x, y, w, h);
  ctx.restore();

  if (glow) {
    ctx.save();
    ctx.shadowColor = "rgba(255, 255, 255, 0.5)";
    ctx.shadowBlur = 18;
    ctx.strokeStyle = "rgba(255, 255, 255, 0.18)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
}

function drawTag() {
  if (state.tag === "none") return;

  const drawn = DRAWN_TAGS[state.tag];
  const tagImg = drawn ? null : state.tagImages[state.tag];
  if (!drawn && !tagImg) return;

  const drawW = drawn ? measureDrawnTag(drawn) : (tagImg.naturalWidth || tagImg.width);
  const drawH = drawn ? TAG_BAR_HEIGHT          : (tagImg.naturalHeight || tagImg.height);

  // Tag is anchored to the dynamic headline top, so it always sits just
  // above the headline regardless of how many lines the headline wrapped to.
  const L = getLayout();
  const tagX = L.tag.x;
  const headlineTop = state._render?.top ?? (canvas.height - L.headline.bottomPadding - 200);
  const tagY = headlineTop - drawH - L.tag.gapAboveHeadline;

  if (drawn) {
    drawTagBadge(drawn, tagX, tagY, drawW, drawH);
    return;
  }

  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.3)";
  ctx.shadowBlur = 12;
  ctx.drawImage(tagImg, tagX, tagY, drawW, drawH);
  ctx.shadowBlur = 0;
  ctx.restore();
}

function measureDrawnTag(tag) {
  ctx.save();
  ctx.font = TAG_FONT;
  const textW = ctx.measureText(tag.label).width;
  ctx.restore();
  const iconW = tag.icon ? TAG_ICON_BOX + TAG_ICON_GAP : 0;
  return Math.round(TAG_PAD_X * 2 + iconW + textW);
}

function drawTagBadge(tag, x, y, w, h) {
  // Only the bar carries the drop shadow — the SVG tags shadow the whole
  // image once, so shadowing the label too would read as a double halo.
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.3)";
  ctx.shadowBlur = 12;
  ctx.fillStyle = tag.bg;
  ctx.fillRect(x, y, w, h);
  ctx.restore();

  ctx.save();
  ctx.fillStyle = "#FFFFFF";
  let cursor = x + TAG_PAD_X;
  if (tag.icon) {
    drawPlayGlyph(cursor, y + (h - TAG_ICON_BOX) / 2, TAG_ICON_BOX);
    cursor += TAG_ICON_BOX + TAG_ICON_GAP;
  }
  ctx.font = TAG_FONT;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  // +1px optical nudge — Poppins' middle baseline sits slightly high in the bar.
  ctx.fillText(tag.label, cursor, y + h / 2 + 1);
  ctx.restore();
}

/* Rounded play triangle, sized to fit a `box`×`box` square at (x, y). */
function drawPlayGlyph(x, y, box) {
  const inset = box * 0.14;
  const left  = x + inset + box * 0.06;
  const top   = y + inset;
  const height = box - inset * 2;
  const width  = height * 0.88;

  ctx.save();
  ctx.beginPath();
  ctx.moveTo(left, top);
  ctx.lineTo(left + width, top + height / 2);
  ctx.lineTo(left, top + height);
  ctx.closePath();
  // Stroking with the fill colour rounds the triangle's corners.
  ctx.lineJoin = "round";
  ctx.lineWidth = box * 0.14;
  ctx.strokeStyle = ctx.fillStyle;
  ctx.stroke();
  ctx.fill();
  ctx.restore();
}

function drawHeadline() {
  // Use the layout + top that renderPoster already computed and cached, so
  // text, gradient, and tag stay in sync. Fall back gracefully if state
  // isn't initialized yet (e.g. very first paint).
  const L = getLayout();
  const cached = state._render || computeHeadlineLayoutAndTop();
  const { layout, top } = cached;
  const text = state.headline || "YOUR HEADLINE HERE";
  const left = L.headline.x;
  const blockHeight = layout.lines.length * layout.lineHeight;

  const allWords = text.trim().split(/\s+/).filter(Boolean);
  const purpleCount = Math.ceil(allWords.length / 2);

  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.font = layout.font;

  let currentlyHighlighted = false;

  // PASS 1: Draw Accent Backgrounds
  layout.lines.forEach((line, lineIndex) => {
    const rawWords = line.split(" ");
    let bgCursor = left;
    const y = top + lineIndex * layout.lineHeight;

    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;

    let segmentStartX = null;
    let segmentWidth = 0;
    let segments = [];

    rawWords.forEach((rawWord, i) => {
      const isOpening = HIGHLIGHT_OPEN_CHAR.test(rawWord);
      const isClosing = HIGHLIGHT_CLOSE_CHAR.test(rawWord);
      const cleanWord = rawWord.replace(HIGHLIGHT_ANY_CHARS_GLOBAL, '');

      if (isOpening) currentlyHighlighted = true;

      const wordWidth = ctx.measureText(cleanWord).width;
      const spaceWidth = ctx.measureText(" ").width;
      const totalAdvance = wordWidth + spaceWidth;

      if (currentlyHighlighted && cleanWord.length > 0) {
        if (segmentStartX === null) {
          segmentStartX = bgCursor;
        }

        let advanceForHighlight = totalAdvance;
        if (isClosing || i === rawWords.length - 1) {
          advanceForHighlight = wordWidth; // Stop highlight at the end of the word cleanly
        }

        segmentWidth += advanceForHighlight;
      }

      if ((isClosing || i === rawWords.length - 1) && segmentStartX !== null) {
        segments.push({ x: segmentStartX, w: segmentWidth });
        segmentStartX = null;
        segmentWidth = 0;
      }

      if (isClosing) currentlyHighlighted = false;
      bgCursor += totalAdvance;
    });

    ctx.fillStyle = state.accent;

    // Pull the actual font size out of the font string (e.g. "600 49px ...")
    // so the highlight box hugs the glyph height, not the line-height. Using
    // lineHeight made the box too tall and bled into the next line's bbox.
    const fontMatch = layout.font.match(/(\d+(?:\.\d+)?)px/);
    const fontSize  = fontMatch ? parseFloat(fontMatch[1]) : Math.round(layout.lineHeight / 1.22);

    const PAD_X        = Math.max(6, Math.round(fontSize * 0.16));  // horizontal breathing room
    const OVERSHOOT_T  = Math.max(2, Math.round(fontSize * 0.06));  // box top above cap line
    const BOX_HEIGHT   = Math.round(fontSize * 0.94);                // hugs glyph height
    const CORNER_RAD   = Math.max(6, Math.round(fontSize * 0.18));

    segments.forEach(seg => {
      const drawX = seg.x - PAD_X;
      const widthToFill = seg.w + PAD_X * 2;
      const drawY = y - OVERSHOOT_T;
      const drawH = BOX_HEIGHT;

      ctx.beginPath();
      ctx.roundRect(drawX, drawY, widthToFill, drawH, CORNER_RAD);
      ctx.fill();
    });
  });

  // reset for pass 2
  currentlyHighlighted = false;

  // PASS 2: Draw White Text with Shadow
  ctx.shadowColor = "rgba(0,0,0,0.6)";
  ctx.shadowBlur = 22;
  ctx.shadowOffsetY = 8;

  layout.lines.forEach((line, lineIndex) => {
    const rawWords = line.split(" ");
    let cursor = left;
    const y = top + lineIndex * layout.lineHeight;

    for (const rawWord of rawWords) {
      const cleanWord = rawWord.replace(HIGHLIGHT_ANY_CHARS_GLOBAL, '');
      if (cleanWord.length > 0) {
        ctx.fillStyle = "#ffffff"; // All text is white
        ctx.fillText(cleanWord + " ", cursor, y);
        cursor += ctx.measureText(cleanWord + " ").width;
      }
    }
  });

  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;
}

/* ── Preview-only UI Overlays (drawn on canvas, excluded from download) ── */

function drawEngagementBar() {
  ctx.save();

  // Scale factor from Zeplin (390 width, 2.36x to reach 920px)
  const scale = 2.36;

  const pillW = Math.round(222.3 * scale); // ~525
  const pillH = Math.round(48.9 * scale);  // ~115
  const shareW = Math.round(48.9 * scale); // ~115
  const gap = Math.round(8 * scale);       // ~19

  const barY = 1700 - Math.round(14 * scale) - Math.round(46 * scale) - Math.round(6 * scale) - pillH;

  // Center align the entire group (pill + gap + share circle)
  const totalW = pillW + gap + shareW;
  const barX = (canvas.width - totalW) / 2;

  // Dark Pill Background
  ctx.fillStyle = "rgba(13, 13, 13, 0.8)";
  ctx.shadowColor = "rgba(0, 0, 0, 0.1)";
  ctx.shadowBlur = 12;
  ctx.shadowOffsetY = 8;

  ctx.beginPath();
  ctx.roundRect(barX, barY, pillW, pillH, pillH / 2);
  ctx.fill();

  // Faint border
  ctx.shadowColor = "transparent";
  ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
  ctx.lineWidth = 2;
  ctx.stroke();

  // Draw Separator Lines
  ctx.strokeStyle = "rgba(255, 255, 255, 0.15)";
  ctx.lineWidth = 1.5;
  const sectionW = pillW / 3;
  const cy = barY + pillH / 2;

  for (let i = 1; i <= 2; i++) {
    ctx.beginPath();
    ctx.moveTo(barX + sectionW * i, cy - 22);
    ctx.lineTo(barX + sectionW * i, cy + 22);
    ctx.stroke();
  }

  // Draw Items
  ctx.fillStyle = "#ffffff";
  ctx.font = "600 32px 'Inter', sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";

  const iconScale = 40;

  const drawItem = (index, iconPath, text, isFill) => {
    const cx = barX + sectionW * index + sectionW / 2;
    const textWidth = ctx.measureText(text).width;
    const itemGap = 12;
    const totalW = iconScale + itemGap + textWidth;

    const startX = cx - totalW / 2 + iconScale / 2;

    // Draw icon
    drawIconPath(startX, cy, iconScale, iconPath, isFill);

    // Draw text
    ctx.fillStyle = "#ffffff";
    ctx.fillText(text, startX + iconScale / 2 + itemGap, cy + 2);
  };

  const LIKE_SOLID = "M2 21h2V9H2v12zm4-9v10a1 1 0 001 1h9.07a2 2 0 001.93-1.49L21.83 11A2 2 0 0019.9 8.5H14V4a2 2 0 00-2-2h-.09a1.65 1.65 0 00-1.56 1.09L7.44 12H6z";
  const DISLIKE_OUTLINE = "M15 3H6c-.83 0-1.54.5-1.84 1.22l-3.02 7.05c-.09.23-.14.47-.14.73v2c0 1.1.9 2 2 2h6.31l-.95 4.57-.03.32c0 .41.17.79.44 1.06L9.83 23l6.59-6.59c.36-.36.58-.86.58-1.41V5c0-1.1-.9-2-2-2zm-1.41 15.41L12 17l1.41-.65V11H7.5l3-7h3.5v9h5.11l-3 7L13.59 18.41zM3 15h4V3H3v12z";
  const COMMENT_OUTLINE = "M20 2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h14l4 4V4c0-1.1-.9-2-2-2zm0 15.17L18.83 16H4V4h16v13.17z";

  drawItem(0, LIKE_SOLID, "1.2k", true);
  drawItem(1, DISLIKE_OUTLINE, "200", false);
  drawItem(2, COMMENT_OUTLINE, "200", false);

  // --- Share Circle ---
  const shareX = barX + pillW + gap;

  ctx.fillStyle = "rgba(13, 13, 13, 0.8)";
  ctx.shadowColor = "rgba(0, 0, 0, 0.1)";
  ctx.shadowBlur = 12;
  ctx.shadowOffsetY = 8;

  ctx.beginPath();
  ctx.arc(shareX + shareW / 2, cy, shareW / 2, 0, Math.PI * 2);
  ctx.fill();

  ctx.shadowColor = "transparent";
  ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
  ctx.lineWidth = 2;
  ctx.stroke();

  const SHARE_SOLID = "M14 9V5l7 7-7 7v-4.1c-5 0-8.5 1.6-11 5.1 1-5 4-10 11-11z";
  drawIconPath(shareX + shareW / 2 - 2, cy - 2, 40, SHARE_SOLID, true);

  ctx.restore();
}

function drawIconPath(cx, cy, size, pathData, isFill = true) {
  ctx.save();
  const scale = size / 24;
  ctx.translate(cx - size / 2, cy - size / 2);
  ctx.scale(scale, scale);
  const p = new Path2D(pathData);
  ctx.fillStyle = isFill ? "#ffffff" : "rgba(255, 255, 255, 0.85)";
  ctx.fill(p);
  ctx.restore();
}

function drawNavBar() {
  ctx.save();
  const scale = 2.36;
  const barW = Math.round(378 * scale); // 892
  const barH = Math.round(46 * scale);  // 108
  const barY = 1700 - Math.round(6 * scale) - barH; // 1578
  const barX = (920 - barW) / 2; // ~14

  // Background
  ctx.fillStyle = "rgba(13, 13, 13, 0.8)";
  ctx.shadowColor = "rgba(0, 0, 0, 0.2)";
  ctx.shadowBlur = 12;
  ctx.beginPath();
  ctx.roundRect(barX, barY, barW, barH, 54);
  ctx.fill();

  // Faint border
  ctx.shadowColor = "transparent";
  ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
  ctx.lineWidth = 2;
  ctx.stroke();

  const cy = barY + barH / 2;

  const NAV_HOME = "M12 5.69l5 4.5V18h-2v-6H9v6H7v-7.81l5-4.5M12 3L2 12h3v8h6v-6h2v6h6v-8h3L12 3z";
  const NAV_VIDEO = "M21 3H3c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h5v2h8v-2h5c1.1 0 1.99-.9 1.99-2L23 5c0-1.1-.9-2-2-2zm0 14H3V5h18v12zm-11-2l6-4-6-4v8z";
  const NAV_DOC_OUTLINE = "M14 2H6a2 2 0 00-2 2v16h16V8l-6-6zm4 18H6V4h7v5h5v11z M8 14h8v-2H8v2z M8 18h8v-2H8v2z M8 10h5V8H8v2z";
  const NAV_AUDIO = "M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z M11 7h2v10h-2z M7 10h2v4H7z M15 10h2v4h-2z";
  const NAV_BOLT = "M11 21h-1l1-7H7.5a.5.5 0 01-.4-.8l3.9-5.2V3h1l-1 7h3.5a.5.5 0 01.4.8L11 16v5z";

  const icons = [NAV_HOME, NAV_VIDEO, NAV_DOC_OUTLINE, NAV_AUDIO, NAV_BOLT];

  const padding = 64;
  const startX = barX + padding;
  const W = barW - padding * 2;

  icons.forEach((path, i) => {
    const cx = startX + i * (W / 4);
    const isAccent = i === 4;

    if (isAccent) {
      // Accent circle
      ctx.beginPath();
      ctx.arc(cx, cy, 40, 0, Math.PI * 2);
      ctx.fillStyle = "#3979FF";
      ctx.fill();
    }

    const iconSize = isAccent ? 40 : 44;
    drawIconPath(cx, cy, iconSize, path, isAccent);
  });

  ctx.restore();
}

function buildHeadlineLayoutFixed(text, maxWidth, size) {
  const cleaned = normalizeHeadlineForPoster(text);
  const font = `600 ${size}px 'Roboto Serif', 'Poppins', serif`;
  ctx.font = font;
  const lines = wrapTextBlock(cleaned, maxWidth);
  return { font, lines, lineHeight: Math.round(size * 1.1) };
}

/* ── Headline Layout ── */

function buildHeadlineLayout(text, maxWidth, _maxLines) {
  const cleaned = normalizeHeadlineForPoster(text);

  // Fixed 48px / 600 weight — text grows downward as lines increase
  const size = 48;
  const font = `600 ${size}px 'Roboto Serif', 'Poppins', serif`;
  ctx.font = font;
  const lines = wrapTextBlock(cleaned, maxWidth);
  return { font, lines, lineHeight: Math.round(size * 1.22) };
}

function normalizeHeadlineForPoster(text) {
  return text
    // Collapse runs of spaces/tabs but KEEP newlines — pressing Enter is a
    // deliberate line break, and /\s+/ used to flatten it into a space.
    .replace(/[^\S\n]+/g, " ")
    .replace(/\r\n?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")        // cap runaway blank runs
    .replace(/^live\s+/i, "")
    .split("\n").map(l => l.trim()).join("\n")
    .replace(/^\n+|\n+$/g, "");
}

/**
 * Wrap a block that may contain manual line breaks: each newline-separated
 * segment is wrapped (and rebalanced) on its own, so an author's break is
 * always honoured and auto-wrapping never pulls words across it.
 */
function wrapTextBlock(text, maxWidth) {
  const out = [];
  for (const segment of text.split("\n")) {
    const words = segment.trim().split(/\s+/).filter(Boolean);
    if (!words.length) {
      out.push("");                     // a deliberate blank line
      continue;
    }
    out.push(...wrapWords(words, maxWidth));
  }
  return out.length ? out : [""];
}

function wrapWords(words, maxWidth) {
  const lines = [];
  let current = "";

  for (const word of words) {
    const test = current ? `${current} ${word}` : word;
    // Strip bracket markers when measuring text width
    if (ctx.measureText(test.replace(HIGHLIGHT_ANY_CHARS_GLOBAL, '')).width <= maxWidth) {
      current = test;
    } else {
      if (current) lines.push(current);
      current = word;
    }
  }

  if (current) lines.push(current);
  return rebalanceLines(lines, maxWidth);
}

function rebalanceLines(lines, maxWidth) {
  if (lines.length < 2) return lines;

  const balanced = [...lines];
  for (let i = 0; i < balanced.length - 1; i += 1) {
    const currentWords = balanced[i].split(" ");
    const nextWords = balanced[i + 1].split(" ");
    if (currentWords.length < 2 || nextWords.length < 2) continue;

    const moved = `${balanced[i]} ${nextWords[0]}`;
    // Strip bracket markers when measuring text width
    if (ctx.measureText(moved.replace(HIGHLIGHT_ANY_CHARS_GLOBAL, '')).width <= maxWidth * 0.98) {
      balanced[i] = moved;
      nextWords.shift();
      balanced[i + 1] = nextWords.join(" ");
    }
  }

  return balanced.filter(Boolean);
}

function compressLines(lines, maxLines) {
  if (lines.length <= maxLines) return lines;

  const kept = lines.slice(0, maxLines - 1);
  const finalLine = lines.slice(maxLines - 1).join(" ");
  kept.push(finalLine.length > 46 ? `${finalLine.slice(0, 43).trimEnd()}...` : finalLine);
  return kept;
}

/* ── Cover Image Drawing ── */

function drawCoverImage(image, x, y, width, height, offset, zoom) {
  const baseScale = Math.max(width / image.width, height / image.height);
  const scale = baseScale * (zoom || 1) * IMAGE_PAN_HEADROOM;
  const drawWidth = image.width * scale;
  const drawHeight = image.height * scale;
  const focal = image.__focalPoint || { x: image.width / 2, y: image.height / 2 };

  let dx = x + width / 2 - focal.x * scale;
  let dy = y + height / 2 - focal.y * scale;

  if (offset) {
    dx += offset.x;
    dy += offset.y;
  }

  const minX = x + width - drawWidth;
  const minY = y + height - drawHeight;
  dx = clamp(dx, minX, x);
  dy = clamp(dy, minY, y);

  // Apply filters (brightness/contrast/saturation/blur) only to the image
  // layer — gradient, headline, logo, etc. should NOT be filtered. Reset to
  // "none" immediately after the draw so subsequent layers render normally.
  ctx.save();
  ctx.filter = buildFilterString();
  ctx.drawImage(image, dx, dy, drawWidth, drawHeight);
  ctx.restore();
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/* ── Image Utilities ── */

async function imageFromUrl(url) {
  if (url.startsWith("data:")) {
    return createImage(url);
  }
  return createImage(`${url}${url.includes("?") ? "&" : "?"}t=${Date.now()}`);
}

async function createImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = async () => {
      await ensureImageFocalPoint(image);
      resolve(image);
    };
    image.onerror = reject;
    image.src = src;
  });
}

async function ensureImageFocalPoint(image) {
  if (image.__focalPoint) return image.__focalPoint;

  let focalPoint = { x: image.width / 2, y: image.height / 2 };
  if (faceDetector) {
    try {
      const faces = await faceDetector.detect(image);
      if (faces?.length) {
        const box = faces[0].boundingBox;
        focalPoint = {
          x: box.x + box.width / 2,
          y: box.y + box.height / 2
        };
      }
    } catch { }
  }

  image.__focalPoint = focalPoint;
  return focalPoint;
}

function waitForImage(image) {
  if (image.complete) return Promise.resolve(image);
  return new Promise((resolve) => {
    image.onload = () => resolve(image);
  });
}

/* ── Placeholder ── */

function makeMainPlaceholder() {
  return makeSvgImage(`
    <svg xmlns="http://www.w3.org/2000/svg" width="920" height="1700" viewBox="0 0 920 1700">
      <defs>
        <linearGradient id="bg" x1="0" y1="0" x2="0.5" y2="1">
          <stop offset="0%" stop-color="#1a1a2e" />
          <stop offset="50%" stop-color="#0f0f1a" />
          <stop offset="100%" stop-color="#050508" />
        </linearGradient>
        <radialGradient id="glow" cx="0.3" cy="0.2" r="0.6">
          <stop offset="0%" stop-color="rgba(139,92,246,0.12)" />
          <stop offset="100%" stop-color="transparent" />
        </radialGradient>
      </defs>
      <rect width="920" height="1700" fill="url(#bg)" />
      <rect width="920" height="1700" fill="url(#glow)" />
      <text x="460" y="800" text-anchor="middle" font-family="Poppins, sans-serif" font-size="38" font-weight="700" fill="rgba(255,255,255,0.1)">Paste a URL to get started</text>
    </svg>
  `);
}

function makeSvgImage(svg) {
  const image = new Image();
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  image.__focalPoint = { x: 460, y: 850 };
  return image;
}

/* ── Helpers ── */

function getDetailTextForPreview() {
  // No headline fallback anywhere in here. The headline belongs to slide 1;
  // echoing it onto slide 2 is the bug, not a graceful default. An empty
  // paragraph shows a prompt instead, which is honest about the card being
  // unfinished rather than looking deliberately duplicated.
  const fallback = "Add key points in Text Paragraph, or generate them from a link.";
  if (!state.isDownloading && state.previewMode === "text") {
    const isWritingText = writeForm && !writeForm.hidden;
    const draftText = isWritingText && writeDetail
      ? writeDetail.value
      : (detailEdit?.value ?? state.detailText ?? "");
    return limitDetailTextClient(draftText.trim() ? draftText : fallback, { preserveOpenBullet: true });
  }

  return limitDetailTextClient((state.detailText || "").trim() || fallback);
}

function handleDetailBulletEnter(event) {
  if (event.key !== "Enter" || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return;

  const field = event.currentTarget;
  const value = field.value || "";
  const selectionStart = field.selectionStart ?? value.length;
  const selectionEnd = field.selectionEnd ?? selectionStart;
  const lineStart = value.lastIndexOf("\n", Math.max(0, selectionStart - 1)) + 1;
  const currentLine = value.slice(lineStart, selectionStart);
  const currentLineText = currentLine.trim();
  const shouldBulletCurrentLine = currentLineText && !/^[\u2022*-]\s+/.test(currentLineText);

  event.preventDefault();

  let nextValue = value;
  let nextStart = selectionStart;
  let nextEnd = selectionEnd;
  if (shouldBulletCurrentLine) {
    nextValue = `${value.slice(0, lineStart)}\u2022 ${value.slice(lineStart)}`;
    nextStart += 2;
    nextEnd += 2;
  }

  const before = nextValue.slice(0, nextStart);
  const after = nextValue.slice(nextEnd);
  const insertion = before.trim() ? "\n\n\u2022 " : "\u2022 ";
  field.value = `${before}${insertion}${after}`;

  const cursor = before.length + insertion.length;
  field.setSelectionRange(cursor, cursor);
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

function formatDetailBulletField(field) {
  const original = field.value || "";
  const formatted = formatDetailBulletText(original);
  if (formatted === original) return original;

  const cursor = field.selectionStart ?? original.length;
  const delta = formatted.length - original.length;
  field.value = formatted;
  const nextCursor = Math.min(field.value.length, Math.max(0, cursor + delta));
  field.setSelectionRange(nextCursor, nextCursor);
  return field.value;
}

function formatDetailBulletText(value) {
  const normalized = (value || "").replace(/\r\n?/g, "\n");
  if (!normalized.trim()) return normalized;

  const wantsNextBullet = /\n$/.test(normalized);
  const hasOpenBullet = /(?:^|\n)\s*[\u2022*-]\s*$/.test(normalized);
  const points = normalized
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line && !/^[\u2022*-]\s*$/.test(line))
    .map((line) => (/^[\u2022*-]\s+/.test(line) ? `\u2022 ${line.replace(/^[\u2022*-]\s+/, "")}` : `\u2022 ${line}`));

  let output = points.join("\n\n");
  if ((wantsNextBullet || hasOpenBullet) && output) {
    output = `${output}\n\n\u2022 `;
  }
  return output;
}

function limitDetailTextClient(value, options = {}) {
  return normalizeDetailTextClient(value, options);
}

function normalizeDetailTextClient(value, { preserveOpenBullet = false } = {}) {
  const lines = (value || "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trimEnd());

  while (!preserveOpenBullet && lines.length && /^[\u2022*-]\s*$/.test(lines[lines.length - 1].trim())) {
    lines.pop();
  }

  return lines
    .join("\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

function limitWordsClient(value, maxWords) {
  return (value || "")
    .replace(/\s+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, maxWords)
    .join(" ");
}

function slugify(value) {
  return (value || "pix-post").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "pix-post";
}

function setStatus(message, type) {
  scrapeStatus.textContent = message;
  scrapeStatus.className = "status-text";
  if (type) scrapeStatus.classList.add(type);
}

/* ═══════════════════════ View switcher (Poster | Article) ═══════════════════════ */

const viewTabs = document.getElementById("view-tabs");
const articleView = document.getElementById("article-view");

function setView(view) {
  document.body.classList.toggle("view-article", view === "article");
  if (articleView) articleView.hidden = view !== "article";
  if (viewTabs) {
    viewTabs.querySelectorAll(".view-tab").forEach(t => {
      const active = t.dataset.view === view;
      t.classList.toggle("active", active);
      t.setAttribute("aria-selected", active ? "true" : "false");
    });
  }
  // The mobile edit sheet makes no sense on the article view — drop it
  if (view === "article") setSheetOpen(false);
}

if (viewTabs) {
  viewTabs.addEventListener("click", (e) => {
    const tab = e.target.closest(".view-tab");
    if (tab) setView(tab.dataset.view);
  });
}

/* ═══════════════════════ AI Article Writer ═══════════════════════ */

const articleGenerateBtn = document.getElementById("article-generate-btn");
const articleStatus      = document.getElementById("article-status");
const articleResult      = document.getElementById("article-result");

function setArticleStatus(msg, kind) {
  if (!articleStatus) return;
  articleStatus.className = "status-text" + (kind ? ` ${kind}` : "");
  articleStatus.textContent = msg || "";
}

/**
 * Generate the article package and fill the slides with it.
 *
 * `applyToSlides` is what closes the loop that used to be missing: the writer
 * produced a headline and bullets that only ever landed in the Article tab and
 * the clipboard, so the poster still showed the raw scraped title and the Text
 * slide still showed the raw scraped paragraph. Now one action fills both.
 */
async function generateArticle({ applyToSlides = false } = {}) {
  const headline = (state.headline || "").trim();
  if (!headline) {
    setArticleStatus("No story yet — scrape a link or write a headline first.", "error");
    return null;
  }

  if (articleGenerateBtn) articleGenerateBtn.disabled = true;
  setArticleStatus("Writing headline, bullets and tweet…");

  try {
    const resp = await fetch("/api/generate-article", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        headline,
        sourceUrl: state.sourceUrl || "",
        // Pass the text we already scraped so the server does not re-fetch.
        articleText: state.articleText || state.detailText || "",
      }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);

    renderArticle(data);

    if (applyToSlides) {
      if (data.headline) {
        state.headline = data.headline;
        if (headlineEdit) headlineEdit.value = data.headline;
        if (writeHeadline) writeHeadline.value = data.headline;
      }
      if (Array.isArray(data.bullets) && data.bullets.length) {
        // Bulleted, one per line — drawPixTextScreen already renders a
        // bullet glyph for lines starting with a dash.
        const block = data.bullets.map((b) => `- ${b}`).join("\n");
        state.detailText = limitDetailTextClient(block);
        if (detailEdit) detailEdit.value = state.detailText;
        if (writeDetail) writeDetail.value = state.detailText;
      }
      renderPoster();
    }

    // Thin sources produce thin bullets; say so rather than let it look
    // like the writer underperformed.
    const thin = data.sourceChars !== undefined && data.sourceChars < 200;
    setArticleStatus(
      thin
        ? "✓ Done — but little source text was found, so the points are general. Check the article link."
        : "✓ Done — review before publishing.",
      thin ? "error" : "success"
    );
    return data;
  } catch (err) {
    setArticleStatus(`Generation failed: ${err.message}`, "error");
    return null;
  } finally {
    if (articleGenerateBtn) articleGenerateBtn.disabled = false;
  }
}

if (articleGenerateBtn) {
  articleGenerateBtn.addEventListener("click", () => generateArticle({ applyToSlides: true }));
}

function renderArticle({ headline, bullets, tweet, flags, spec }) {
  // The editorial spec travels with the payload, so these numbers live in
  // exactly one place (server.mjs). Fallbacks only matter for a cached
  // response from an older deploy.
  const HEADLINE_MAX_CHARS = spec?.headlineMax ?? 90;
  const BULLET_MIN_CHARS   = spec?.bulletMin   ?? 115;
  const BULLET_MAX_CHARS   = spec?.bulletMax   ?? 125;

  const headEl   = document.getElementById("article-headline");
  const bulletEl = document.getElementById("article-bullets");
  const tweetEl  = document.getElementById("article-tweet");
  const flagsBlk = document.getElementById("article-flags-block");
  const flagsEl  = document.getElementById("article-flags");

  headEl.textContent = headline;
  const headCount = document.getElementById("article-headline-count");
  headCount.textContent = `${headline.length} / ${HEADLINE_MAX_CHARS}`;
  headCount.classList.toggle("over", headline.length > HEADLINE_MAX_CHARS);

  // Per-bullet counts. The spec is a tight character band, so showing the
  // actual length per bullet is the only way to see at a glance whether the
  // model hit it — a total or an average would hide one bad bullet.
  bulletEl.innerHTML = "";
  bullets.forEach(b => {
    const li = document.createElement("li");
    const text = document.createElement("span");
    text.textContent = b;
    const count = document.createElement("span");
    count.className = "bullet-count";
    count.textContent = b.length;
    const outOfBand = b.length < BULLET_MIN_CHARS || b.length > BULLET_MAX_CHARS;
    count.classList.toggle("over", outOfBand);
    count.title = outOfBand
      ? `${b.length} characters — outside the ${BULLET_MIN_CHARS}-${BULLET_MAX_CHARS} target`
      : `${b.length} characters`;
    li.append(text, count);
    bulletEl.appendChild(li);
  });

  tweetEl.textContent = tweet;
  const tweetCount = document.getElementById("article-tweet-count");
  tweetCount.textContent = `${tweet.length} / 280`;
  tweetCount.classList.toggle("over", tweet.length > 280);

  if (flags && flags.length) {
    flagsEl.innerHTML = "";
    flags.forEach(f => {
      const li = document.createElement("li");
      li.textContent = f;
      flagsEl.appendChild(li);
    });
    flagsBlk.hidden = false;
  } else {
    flagsBlk.hidden = true;
  }

  articleResult.hidden = false;
}

// Copy buttons — per-block and copy-all
function flashCopied(btn) {
  const prev = btn.textContent;
  btn.textContent = "Copied ✓";
  btn.classList.add("copied");
  setTimeout(() => { btn.textContent = prev; btn.classList.remove("copied"); }, 1400);
}

document.querySelectorAll(".copy-btn[data-copy-target]").forEach(btn => {
  btn.addEventListener("click", async () => {
    const el = document.getElementById(btn.dataset.copyTarget);
    if (!el) return;
    const text = el.tagName === "UL"
      ? [...el.querySelectorAll("li")].map(li => `• ${li.textContent}`).join("\n")
      : el.textContent;
    try {
      await navigator.clipboard.writeText(text);
      flashCopied(btn);
    } catch { /* clipboard denied */ }
  });
});

const copyAllBtn = document.getElementById("article-copy-all");
if (copyAllBtn) {
  copyAllBtn.addEventListener("click", async () => {
    const head    = document.getElementById("article-headline")?.textContent || "";
    const bullets = [...document.querySelectorAll("#article-bullets li")].map(li => `• ${li.textContent}`).join("\n");
    const tweet   = document.getElementById("article-tweet")?.textContent || "";
    const full = `${head}\n\n${bullets}\n\n${tweet}`;
    try {
      await navigator.clipboard.writeText(full);
      const prev = copyAllBtn.textContent;
      copyAllBtn.textContent = "✓ Copied everything";
      setTimeout(() => { copyAllBtn.textContent = prev; }, 1400);
    } catch { /* clipboard denied */ }
  });
}

/* ═══════════════════════ AI Enhance ═══════════════════════ */

const aiEnhanceBtn    = document.getElementById("ai-enhance-btn");
const aiEnhanceStatus = document.getElementById("ai-enhance-status");

/* When the server points at the Pix Upscaler GPT, upscaling moves to the
   user's own ChatGPT account: paste there, copy the result, paste it back
   above. The built-in button is hidden rather than left disabled — a greyed
   button invites clicking and explains nothing, whereas the steps say where
   the work actually happens. The server refuses /api/upscale-image in this
   mode too, so hiding the button is presentation, not the guard. */
(function configureEnhanceRoute() {
  const gptUrl = (window.PIX_CONFIG?.upscalerGptUrl || "").trim();
  const external = document.getElementById("enhance-external");
  const builtin  = document.getElementById("enhance-builtin");
  const link     = document.getElementById("upscaler-gpt-link");
  if (!gptUrl || !external || !builtin || !link) return;

  link.href = gptUrl;
  external.hidden = false;
  builtin.hidden  = true;

  /* Getting the photo TO the GPT is the part with no obvious answer: the
     clipboard usually holds whatever was copied last (the article URL, most
     often), so Ctrl+V over there pastes a link instead of an image. This puts
     the actual background on the clipboard as a PNG. */
  const copyBtn    = document.getElementById("copy-source-btn");
  const copyStatus = document.getElementById("copy-source-status");
  if (!copyBtn) return;

  const setCopyStatus = (msg, kind) => {
    if (!copyStatus) return;
    copyStatus.className = "status-text" + (kind ? ` ${kind}` : "");
    copyStatus.textContent = msg || "";
  };

  // Enabling is driven by the paint pass, alongside the AI Enhance button.
  copyBtn.disabled = !state.mainImage;

  copyBtn.addEventListener("click", async () => {
    const img = state.mainImage;
    if (!img) return;

    // "working" is the flag the paint pass checks before re-enabling, so an
    // in-flight copy is not undone by an unrelated repaint.
    copyBtn.classList.add("working");
    copyBtn.disabled = true;
    setCopyStatus("Copying…");
    try {
      // Full resolution, not the preview size — the GPT should upscale from
      // the best source available, and downscaling first would throw away
      // exactly the detail we are asking it to recover.
      const w = img.naturalWidth || img.width;
      const h = img.naturalHeight || img.height;
      const tmp = document.createElement("canvas");
      tmp.width = w;
      tmp.height = h;
      tmp.getContext("2d").drawImage(img, 0, 0, w, h);

      const blob = await new Promise((resolve, reject) => {
        tmp.toBlob((b) => (b ? resolve(b) : reject(new Error("Could not read the image."))), "image/png");
      });
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      setCopyStatus(`Copied at ${w}x${h}. Open Pix Upscaler and press Ctrl+V.`, "success");
    } catch (err) {
      // Clipboard image writes need a secure context and permission; if either
      // is missing, say what to do instead rather than just failing.
      setCopyStatus(
        `Could not copy automatically (${err.message}). Right-click the preview and choose "Copy image", or download it and drag the file into Pix Upscaler.`,
        "error",
      );
    } finally {
      copyBtn.classList.remove("working");
      copyBtn.disabled = !state.mainImage;
    }
  });
})();

function setEnhanceStatus(msg, kind) {
  if (!aiEnhanceStatus) return;
  aiEnhanceStatus.className = "status-text" + (kind ? ` ${kind}` : "");
  aiEnhanceStatus.textContent = msg || "";
}

if (aiEnhanceBtn) {
  aiEnhanceBtn.addEventListener("click", async () => {
    const img = state.mainImage;
    if (!img) return;

    aiEnhanceBtn.disabled = true;
    aiEnhanceBtn.classList.add("working");
    setEnhanceStatus("Enhancing with AI — analysing photo, then rebuilding detail (30–90s)…");

    try {
      // Snapshot the current background to a temp canvas, capped at 1536 on
      // the long edge (gpt-image-1's max output — no point uploading more).
      const rawW = img.naturalWidth || img.width;
      const rawH = img.naturalHeight || img.height;
      const scale = Math.min(1, 1536 / Math.max(rawW, rawH));
      const tmp = document.createElement("canvas");
      tmp.width  = Math.round(rawW * scale);
      tmp.height = Math.round(rawH * scale);
      tmp.getContext("2d").drawImage(img, 0, 0, tmp.width, tmp.height);

      const blob = await new Promise(r => tmp.toBlob(r, "image/png"));
      if (!blob) throw new Error("Couldn't read the current image.");

      const resp = await fetch("/api/upscale-image", {
        method: "POST",
        headers: {
          "Content-Type": "image/png",
          "X-Image-Orientation": rawW >= rawH ? "landscape" : "portrait",
          // The selected poster ratio drives the generated image's shape —
          // a 9:16 poster gets a portrait render (outpainted if needed).
          "X-Poster-Ratio": state.aspectRatio || "",
          // Story context helps the vision stage understand what the photo
          // shows, which sharpens the "preserve exactly this" instructions.
          "X-Headline": encodeURIComponent((state.headline || "").slice(0, 200)),
          // How much of the model output to keep. Both upscalers manufacture
          // roughly twice the fine detail the original had, which is what
          // reads as a painted face; mixing back toward a plain resample is
          // the dial for that.
          "X-Enhance-Strength": String((state.enhanceStrength ?? 70) / 100),
        },
        body: blob,
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
      if (!data.image) throw new Error("No image returned.");

      // Swap the background for the enhanced version
      const enhanced = new Image();
      await new Promise((resolve, reject) => {
        enhanced.onload = resolve;
        enhanced.onerror = () => reject(new Error("Enhanced image failed to load."));
        enhanced.src = data.image;
      });
      await ensureImageFocalPoint(enhanced);
      state.mainImage = enhanced;
      renderPoster();
      const ENGINE_LABELS = {
        realesrgan: "Real-ESRGAN (self-hosted, free)",
        codeformer: "CodeFormer (self-hosted, free)",
      };
      const engineLabel = ENGINE_LABELS[data.engine] || data.engine || "AI";
      setEnhanceStatus(`✓ Enhanced via ${engineLabel}. Re-pick a stock image to undo.`, "success");
    } catch (err) {
      setEnhanceStatus(`Enhance failed: ${err.message}`, "error");
    } finally {
      aiEnhanceBtn.classList.remove("working");
      aiEnhanceBtn.disabled = !state.mainImage;
    }
  });
}

/* ── Theme toggle (dark default; persisted in localStorage) ── */
(function initThemeToggle() {
  const btn = document.getElementById("theme-toggle");
  if (!btn) return;

  const themeColorMeta = document.querySelector('meta[name="theme-color"]');

  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("pix-theme", theme);
    if (themeColorMeta) {
      themeColorMeta.setAttribute("content", theme === "dark" ? "#0b0a13" : "#eeecf7");
    }
    btn.setAttribute("aria-label", theme === "dark" ? "Switch to light theme" : "Switch to dark theme");
  }

  // Sync meta/aria with whatever the head bootstrap already applied
  applyTheme(document.documentElement.dataset.theme || "dark");

  btn.addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    applyTheme(next);
  });
})();

/* ═══════════════════════ Slide 2 — video ═══════════════════════

   Slide 2 is either the Text card or a video clip. The clip comes from a
   YouTube/Instagram link (fetched server-side with yt-dlp) or a local file,
   gets trimmed to a range chosen here, and is exported with the Pix branding
   burned in by ffmpeg.

   Both endpoints are ordinary same-origin routes on this server, which
   shells out to yt-dlp and ffmpeg. An earlier version POSTed to a separate
   host with an HMAC token because Vercel caps serverless request bodies at
   4.5 MB, far below a video upload — Railway has no such cap, so the second
   service, the shared secret and the CORS config are all gone.
   ══════════════════════════════════════════════════════════════ */

const MAX_CLIP_SECONDS = 90;          // matches MAX_CLIP_SECONDS on the service
const MAX_VIDEO_UPLOAD_BYTES = 300 * 1024 * 1024;

const videoUrlInput    = document.getElementById("video-url");
const videoFetchBtn    = document.getElementById("video-fetch-btn");
const videoFileInput   = document.getElementById("video-file-input");
const videoFileDrop    = document.getElementById("video-file-drop");
const videoFileLabel   = document.getElementById("video-file-label");
const videoStatusEl    = document.getElementById("video-status");
const videoEditor      = document.getElementById("video-editor");
const videoPreviewEl   = document.getElementById("video-preview");
const videoSourceTabs  = document.getElementById("video-source-tabs");
const trimStartInput   = document.getElementById("trim-start");
const trimEndInput     = document.getElementById("trim-end");
const trimStartLabel   = document.getElementById("trim-start-label");
const trimEndLabel     = document.getElementById("trim-end-label");
const trimDurationEl   = document.getElementById("trim-duration");
const videoMuteInput   = document.getElementById("video-mute");
const videoExportBtn   = document.getElementById("video-export-btn");

function setVideoStatus(message, type) {
  if (!videoStatusEl) return;
  videoStatusEl.textContent = message || "";
  videoStatusEl.className = "status-text";
  if (type) videoStatusEl.classList.add(type);
}

function formatTimecode(seconds) {
  const s = Math.max(0, seconds || 0);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return `${m}:${rest.toFixed(1).padStart(4, "0")}`;
}

/* The video endpoints are ordinary same-origin routes on this server — the
   backend shells out to yt-dlp and ffmpeg. There is no second host, no
   shared secret and no token exchange: that only existed to work around
   Vercel's 4.5 MB serverless body cap, which Railway doesn't have. */

// Swap the export button into a visible working state. The encode reports no
// percentage, so this is an indeterminate "still going" signal, not progress.
function setExportWorking(working) {
  const btn = document.getElementById("video-export-btn");
  const label = document.getElementById("video-export-label");
  const bar = document.getElementById("video-export-progress");
  if (btn) btn.classList.toggle("working", working);
  if (label) label.textContent = working ? "Exporting…" : "Export Video";
  if (bar) bar.hidden = !working;
}

async function mediaErrorMessage(res) {
  const data = await res.json().catch(() => null);
  if (data && data.error) return data.error;
  if (res.status === 413) return "That file is too large.";
  if (res.status === 504) return "The server timed out. Try a shorter clip.";
  return `Server error ${res.status}.`;
}

/* ── Source: pasted link ── */
async function fetchVideoFromUrl(url) {
  setVideoStatus("Fetching video details…");
  if (videoFetchBtn) videoFetchBtn.disabled = true;
  try {
    const res = await fetch("/api/video/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
    if (!res.ok) throw new Error(await mediaErrorMessage(res));

    const meta = await res.json();
    state.videoUrl = meta.webpage_url || url;
    state.videoFile = null;
    state.videoMeta = meta;
    state.videoSourceKind = "link";

    setupTrimRange(meta.duration || 0);
    if (videoEditor) videoEditor.hidden = false;

    const len = meta.duration ? ` · ${formatTimecode(meta.duration)}` : "";
    setVideoStatus(`${meta.title || "Video"}${len} — loading preview…`);

    // A browser can't play a YouTube/Instagram page URL, so the server
    // fetches a small copy and streams it back same-origin. Without this the
    // element shows a poster only and trimming is blind guesswork.
    if (videoPreviewEl) {
      videoPreviewEl.poster = meta.thumbnail || "";
      videoPreviewEl.src = `/api/video/preview?u=${encodeURIComponent(state.videoUrl)}`;
      videoPreviewEl.addEventListener("loadedmetadata", () => {
        // yt-dlp's reported duration can disagree slightly with the actual
        // stream; the decoded value is what the scrubber must match.
        if (videoPreviewEl.duration && Number.isFinite(videoPreviewEl.duration)) {
          setupTrimRange(videoPreviewEl.duration);
        }
        setVideoStatus(`${meta.title || "Video"}${len}`, "success");
        renderPoster();
      }, { once: true });
      videoPreviewEl.addEventListener("error", () => {
        // Preview is a convenience — trimming by timecode still works, so
        // don't tear the editor down, just say so.
        setVideoStatus(
          `${meta.title || "Video"}${len} — preview unavailable, trim by time`,
          "error"
        );
      }, { once: true });
      videoPreviewEl.load();
    }
  } catch (err) {
    setVideoStatus(err.message, "error");
  } finally {
    if (videoFetchBtn) videoFetchBtn.disabled = false;
  }
}

/* ── Source: local file ── */
function loadLocalVideoFile(file) {
  if (!file) return;
  if (!file.type.startsWith("video/")) {
    setVideoStatus("That is not a video file.", "error");
    return;
  }
  if (file.size > MAX_VIDEO_UPLOAD_BYTES) {
    setVideoStatus(`That file is ${(file.size / 1048576).toFixed(0)} MB; the limit is 300 MB.`, "error");
    return;
  }

  state.videoFile = file;
  state.videoUrl = "";
  state.videoMeta = null;
  state.videoSourceKind = "file";
  if (videoFileLabel) videoFileLabel.textContent = file.name;

  const objectUrl = URL.createObjectURL(file);
  if (videoPreviewEl) {
    videoPreviewEl.poster = "";
    videoPreviewEl.src = objectUrl;
    // Revoking on load would break seeking — the URL is released when the
    // source is replaced instead.
    videoPreviewEl.addEventListener("loadedmetadata", () => {
      setupTrimRange(videoPreviewEl.duration || 0);
      if (videoEditor) videoEditor.hidden = false;
      setVideoStatus(`${file.name} · ${formatTimecode(videoPreviewEl.duration)}`, "success");
      renderPoster();
      if (!videoPreviewEl.paused) startVideoPreviewLoop();
    }, { once: true });
  }
}

/* ── Trim ── */
function setupTrimRange(duration) {
  const dur = Math.max(0, duration || 0);
  state.trimStart = 0;
  state.trimEnd = Math.min(dur || MAX_CLIP_SECONDS, MAX_CLIP_SECONDS);
  if (trimStartInput) {
    trimStartInput.max = String(dur || MAX_CLIP_SECONDS);
    trimStartInput.value = "0";
  }
  if (trimEndInput) {
    trimEndInput.max = String(dur || MAX_CLIP_SECONDS);
    trimEndInput.value = String(state.trimEnd);
  }
  syncTrimUI();
}

function syncTrimUI() {
  const duration = Math.max(0, state.trimEnd - state.trimStart);
  if (trimStartLabel) trimStartLabel.textContent = formatTimecode(state.trimStart);
  if (trimEndLabel) trimEndLabel.textContent = formatTimecode(state.trimEnd);
  if (trimDurationEl) {
    trimDurationEl.textContent = `${duration.toFixed(1)}s`;
    trimDurationEl.classList.toggle("over-limit", duration > MAX_CLIP_SECONDS || duration <= 0);
  }
  if (videoExportBtn) {
    videoExportBtn.disabled =
      state.videoExporting || duration <= 0 || duration > MAX_CLIP_SECONDS ||
      (!state.videoUrl && !state.videoFile);
  }
}

// Start and End get one range input each; clamping here (rather than
// building a custom dual-handle widget) is what stops them crossing over.
if (trimStartInput) {
  trimStartInput.addEventListener("input", () => {
    state.trimStart = Math.min(parseFloat(trimStartInput.value) || 0, state.trimEnd - 0.1);
    trimStartInput.value = String(state.trimStart);
    if (videoPreviewEl && videoPreviewEl.src) videoPreviewEl.currentTime = state.trimStart;
    syncTrimUI();
  });
}

if (trimEndInput) {
  trimEndInput.addEventListener("input", () => {
    state.trimEnd = Math.max(parseFloat(trimEndInput.value) || 0, state.trimStart + 0.1);
    trimEndInput.value = String(state.trimEnd);
    if (videoPreviewEl && videoPreviewEl.src) videoPreviewEl.currentTime = state.trimEnd;
    syncTrimUI();
  });
}

const trimSetStartBtn = document.getElementById("trim-set-start");
if (trimSetStartBtn) {
  trimSetStartBtn.addEventListener("click", () => {
    if (!videoPreviewEl || !videoPreviewEl.src) return;
    state.trimStart = Math.min(videoPreviewEl.currentTime, state.trimEnd - 0.1);
    if (trimStartInput) trimStartInput.value = String(state.trimStart);
    syncTrimUI();
  });
}

const trimSetEndBtn = document.getElementById("trim-set-end");
if (trimSetEndBtn) {
  trimSetEndBtn.addEventListener("click", () => {
    if (!videoPreviewEl || !videoPreviewEl.src) return;
    state.trimEnd = Math.max(videoPreviewEl.currentTime, state.trimStart + 0.1);
    if (trimEndInput) trimEndInput.value = String(state.trimEnd);
    syncTrimUI();
  });
}

// Preview exactly the selected range, then stop at the out-point.
const trimPlayBtn = document.getElementById("trim-play");
if (trimPlayBtn) {
  trimPlayBtn.addEventListener("click", () => {
    if (!videoPreviewEl || !videoPreviewEl.src) {
      setVideoStatus("Load a video first.", "error");
      return;
    }
    videoPreviewEl.currentTime = state.trimStart;
    videoPreviewEl.play();
    const stopAtEnd = () => {
      if (videoPreviewEl.currentTime >= state.trimEnd) {
        videoPreviewEl.pause();
        videoPreviewEl.removeEventListener("timeupdate", stopAtEnd);
      }
    };
    videoPreviewEl.addEventListener("timeupdate", stopAtEnd);
  });
}

if (videoMuteInput) {
  videoMuteInput.addEventListener("change", () => {
    state.videoMuted = videoMuteInput.checked;
  });
}

/* The caption is painted by drawPixVideoScreen, which produces both the
   live preview and the PNG ffmpeg burns in — so a repaint is all that's
   needed here, and what you see is exactly what gets exported. */
const videoCaptionInput = document.getElementById("video-caption");
if (videoCaptionInput) {
  videoCaptionInput.addEventListener("input", () => {
    state.videoCaption = videoCaptionInput.value;
    renderPoster();
  });
}

const videoCaptionSizeInput = document.getElementById("video-caption-size");
if (videoCaptionSizeInput) {
  videoCaptionSizeInput.addEventListener("input", () => {
    state.videoCaptionSize = Number(videoCaptionSizeInput.value) || 40;
    renderPoster();
  });
}

/* ── Source tabs ── */
if (videoSourceTabs) {
  videoSourceTabs.addEventListener("click", (e) => {
    const btn = e.target.closest(".video-source-tab");
    if (!btn) return;
    const kind = btn.dataset.videoSource === "file" ? "file" : "link";
    videoSourceTabs.querySelectorAll(".video-source-tab").forEach((t) => {
      const active = t === btn;
      t.classList.toggle("active", active);
      t.setAttribute("aria-selected", active ? "true" : "false");
    });
    document.getElementById("video-source-link").hidden = kind !== "link";
    document.getElementById("video-source-file").hidden = kind !== "file";
  });
}

if (videoFetchBtn) {
  videoFetchBtn.addEventListener("click", () => {
    const url = (videoUrlInput ? videoUrlInput.value : "").trim();
    if (!/^https?:\/\//i.test(url)) {
      setVideoStatus("Paste a full https:// link.", "error");
      return;
    }
    fetchVideoFromUrl(url);
  });
}

if (videoUrlInput) {
  videoUrlInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); if (videoFetchBtn) videoFetchBtn.click(); }
  });
}

if (videoFileInput) {
  videoFileInput.addEventListener("change", (e) => loadLocalVideoFile(e.target.files && e.target.files[0]));
}

if (videoFileDrop) {
  ["dragenter", "dragover"].forEach((ev) =>
    videoFileDrop.addEventListener(ev, (e) => {
      e.preventDefault();
      videoFileDrop.classList.add("dragover");
    })
  );
  ["dragleave", "drop"].forEach((ev) =>
    videoFileDrop.addEventListener(ev, (e) => {
      e.preventDefault();
      videoFileDrop.classList.remove("dragover");
    })
  );
  videoFileDrop.addEventListener("drop", (e) => {
    const files = (e.dataTransfer && e.dataTransfer.files) || [];
    const file = [...files].find((f) => f.type.startsWith("video/"));
    if (file) loadLocalVideoFile(file);
    else setVideoStatus("Drop a video file.", "error");
  });
}

/* ── Export ── */
async function exportVideoClip() {
  if (state.videoExporting) return;
  const duration = state.trimEnd - state.trimStart;
  if (duration <= 0) { setVideoStatus("Set a trim range first.", "error"); return; }
  if (!state.videoUrl && !state.videoFile) { setVideoStatus("Load a video first.", "error"); return; }

  state.videoExporting = true;
  syncTrimUI();
  setExportWorking(true);
  setVideoStatus("Rendering overlay…");

  try {
    const { width, height } = videoTargetSize();
    const overlay = await renderVideoOverlayPng(width, height);

    const form = new FormData();
    form.append("start", String(state.trimStart));
    form.append("end", String(state.trimEnd));
    form.append("width", String(width));
    form.append("height", String(height));
    form.append("mute", state.videoMuted ? "true" : "false");
    // ffmpeg must crop the same slice the preview showed, or the exported
    // clip is framed differently from what was approved on screen.
    form.append("focusX", String(state.videoFocus?.x ?? 0.5));
    form.append("focusY", String(state.videoFocus?.y ?? 0.5));
    if (overlay) form.append("overlay", overlay, "overlay.png");
    if (state.videoFile) {
      form.append("video", state.videoFile, state.videoFile.name);
      setVideoStatus(`Uploading and encoding ${duration.toFixed(1)}s… this can take a few minutes.`);
    } else {
      form.append("url", state.videoUrl);
      setVideoStatus(`Downloading and encoding ${duration.toFixed(1)}s… this can take a few minutes.`);
    }

    // No AbortController timeout: a long download plus encode legitimately
    // runs for minutes, and aborting here would kill work the server is
    // still doing without telling it to stop.
    // No Content-Type header — the browser sets the multipart boundary.
    const res = await fetch("/api/video/clip", { method: "POST", body: form });
    if (!res.ok) throw new Error(await mediaErrorMessage(res));

    const blob = await res.blob();
    if (blob.size < 1000) throw new Error("The encoder returned an empty file.");

    const title = (state.videoMeta && state.videoMeta.title) || state.headline || "pix-clip";
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `${slugify(title)}-slide2.mp4`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 10000);

    setVideoStatus(`Exported ${(blob.size / 1048576).toFixed(1)} MB · ${width}×${height}`, "success");
  } catch (err) {
    // A dropped connection surfaces as a bare "Failed to fetch", which tells
    // the user nothing — name the likely cause.
    const msg = /failed to fetch|networkerror|load failed/i.test(err.message || "")
      ? "Lost connection to the server during export. The clip may be too large — try a shorter range."
      : (err.message || "Export failed.");
    setVideoStatus(msg, "error");
  } finally {
    state.videoExporting = false;
    setExportWorking(false);
    syncTrimUI();
  }
}

if (videoExportBtn) videoExportBtn.addEventListener("click", exportVideoClip);

// The canvas preview reads frames straight off this element.
if (videoPreviewEl) {
  state.videoEl = videoPreviewEl;
  // Playback drives the rAF loop; everything else is a single repaint.
  // The video card is always visible in the rail, so these fire unconditionally.
  // They used to be gated on state.previewMode === "video", which is only true
  // transiently while that card is being painted — so in practice the guard was
  // always false and the card never updated on play or seek.
  videoPreviewEl.addEventListener("play", () => startVideoPreviewLoop());
  ["seeked", "loadeddata", "pause", "ended"].forEach((ev) =>
    videoPreviewEl.addEventListener(ev, () => renderPoster())
  );
}

syncTrimUI();

/* ── Per-card downloads ──
   Each preview card owns its own export. Previously one button exported
   "whatever mode the toggle happened to be in", which is how the X download
   once shipped the Text slide — the mode was ambient state rather than
   something the action declared. Here the button names its slide. */

async function downloadSlide(mode) {
  const prev = {
    mode: state.previewMode,
    downloading: state.isDownloading,
    forceText: state.forceTextExport,
    shortly: state.useShortlyLogo,
  };
  state.isDownloading = true;
  state.previewMode = mode;
  state.forceTextExport = mode === "text";
  state.useShortlyLogo = false;

  let result = null;
  try {
    result = await renderExportBlob();
  } catch (err) {
    console.error(`${mode} export failed:`, err);
  } finally {
    state.isDownloading = prev.downloading;
    state.previewMode = prev.mode;
    state.forceTextExport = prev.forceText;
    state.useShortlyLogo = prev.shortly;
    renderPoster();
  }
  if (!result) return null;

  const suffix = mode === "pix" ? "" : `-${mode}`;
  const url = URL.createObjectURL(result.blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${slugify(state.headline || "pix-post")}${suffix}.png`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return result;
}

const previewRail = document.getElementById("preview-rail");
if (previewRail) {
  previewRail.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-download]");
    if (!btn) return;
    const mode = btn.dataset.download;

    // X has its own export path: 2x scale (X rejects PNGs over 5 MB),
    // cropped to content, Shortly logo instead of Pix.
    if (mode === "x") {
      downloadXPreview();
      return;
    }

    // The video slide is an MP4 from the server, not a canvas PNG.
    if (mode === "video") {
      if (!state.videoUrl && !state.videoFile) {
        setStatus("Add a video in Slide 2 Video first.", "error");
        return;
      }
      exportVideoClip();
      return;
    }

    btn.disabled = true;
    const label = btn.textContent;
    btn.textContent = "Rendering…";
    try {
      const r = await downloadSlide(mode);
      setStatus(r ? `Slide downloaded (${r.width}×${r.height}).` : "Export failed.", r ? "success" : "error");
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  });
}


/* ── Rail navigation ──
   Arrows page the carousel by one card. They hide themselves when everything
   already fits, so on a wide screen the header stays clean instead of
   carrying two controls that do nothing. */
(() => {
  const rail = document.getElementById("preview-rail");
  const prev = document.getElementById("rail-prev");
  const next = document.getElementById("rail-next");
  if (!rail || !prev || !next) return;

  const step = () => {
    const card = rail.querySelector(".preview-card");
    // Card width plus the gap, so one press moves exactly one card.
    const gap = parseFloat(getComputedStyle(rail).columnGap || getComputedStyle(rail).gap || "14") || 14;
    return card ? card.getBoundingClientRect().width + gap : rail.clientWidth * 0.8;
  };

  const scrollable = () => rail.scrollWidth - rail.clientWidth > 4;

  function sync() {
    const on = scrollable();
    prev.hidden = next.hidden = !on;
    if (!on) return;
    // Disable rather than hide at the ends — a control that vanishes
    // mid-interaction makes the row jump.
    prev.disabled = rail.scrollLeft <= 2;
    next.disabled = rail.scrollLeft >= rail.scrollWidth - rail.clientWidth - 2;
  }

  prev.addEventListener("click", () => rail.scrollBy({ left: -step(), behavior: "smooth" }));
  next.addEventListener("click", () => rail.scrollBy({ left:  step(), behavior: "smooth" }));
  rail.addEventListener("scroll", sync, { passive: true });
  window.addEventListener("resize", sync);
  // The cards resize when the aspect ratio changes, which changes whether the
  // rail overflows at all.
  if (window.ResizeObserver) new ResizeObserver(sync).observe(rail);

  // Layout is not settled when this module runs, so the first sync would read
  // scrollWidth === clientWidth and leave the arrows in the wrong state.
  sync();
  requestAnimationFrame(sync);
  window.addEventListener("load", sync);
})();


/* ── Drag to reframe the video slide ──
   Cropping a landscape clip to 9:16 throws away most of its width, so the
   default centre crop often cuts the subject in half. Dragging the video
   card picks the slice to keep. The value is normalised, so the preview and
   ffmpeg's crop agree at any resolution. */
(() => {
  const card = document.getElementById("video-canvas");
  if (!card) return;

  let dragging = false;
  let startX = 0, startY = 0, startFocus = null;

  const hasVideo = () => {
    const v = state.videoEl;
    return v && v.readyState >= 2 && v.videoWidth > 0;
  };

  // How far the frame can travel on each axis, in canvas pixels. Zero on the
  // axis that exactly fits — dragging there would only reveal black.
  function overflow() {
    const v = state.videoEl;
    const scale = Math.max(canvas.width / v.videoWidth, canvas.height / v.videoHeight);
    return {
      x: Math.max(0, v.videoWidth * scale - canvas.width),
      y: Math.max(0, v.videoHeight * scale - canvas.height),
    };
  }

  function pointerDown(e) {
    if (!hasVideo()) return;
    dragging = true;
    startX = e.clientX;
    startY = e.clientY;
    startFocus = { ...(state.videoFocus || { x: 0.5, y: 0.5 }) };
    card.setPointerCapture?.(e.pointerId);
    card.classList.add("dragging");
    e.preventDefault();
  }

  function pointerMove(e) {
    if (!dragging) return;
    const rect = card.getBoundingClientRect();
    // The card is displayed smaller than the canvas, so convert CSS pixels
    // of travel into canvas pixels before dividing by the overflow.
    const scaleToCanvas = canvas.width / rect.width;
    const over = overflow();
    const dx = (e.clientX - startX) * scaleToCanvas;
    const dy = (e.clientY - startY) * scaleToCanvas;
    const next = {
      x: over.x ? clamp(startFocus.x - dx / over.x, 0, 1) : 0.5,
      y: over.y ? clamp(startFocus.y - dy / over.y, 0, 1) : 0.5,
    };
    state.videoFocus = next;
    renderPoster();
  }

  function pointerUp(e) {
    if (!dragging) return;
    dragging = false;
    card.releasePointerCapture?.(e.pointerId);
    card.classList.remove("dragging");
  }

  card.addEventListener("pointerdown", pointerDown);
  card.addEventListener("pointermove", pointerMove);
  card.addEventListener("pointerup", pointerUp);
  card.addEventListener("pointercancel", pointerUp);

  // Double-click recentres — quicker than dragging back by feel.
  card.addEventListener("dblclick", () => {
    state.videoFocus = { x: 0.5, y: 0.5 };
    renderPoster();
  });
})();

// Timestamp toggle — the stamp is on by default; some posters do not want it.
const showTimestampInput = document.getElementById("show-timestamp");
if (showTimestampInput) {
  showTimestampInput.addEventListener("change", () => {
    state.showTimestamp = showTimestampInput.checked;
    renderPoster();
  });
}


/* ── Keep the date stamp current ──
   Computing the date at paint time is only half of it: an idle tab never
   repaints, so the canvas would keep showing the day it was last drawn.
   This schedules a repaint just after local midnight, and re-checks whenever
   the tab becomes visible again — a sleeping laptop does not fire timers, so
   waking up is the case a timer alone would miss. Also covers the machine's
   clock or timezone being changed while the tab sits open. */
(() => {
  const label = () => formatCreatedAt(state.createdAt);
  let lastLabel = label();
  let timer = 0;

  function refreshIfRolledOver() {
    const now = label();
    if (now !== lastLabel) {
      lastLabel = now;
      renderPoster();
    }
  }

  function scheduleNextMidnight() {
    clearTimeout(timer);
    const now = new Date();
    const nextMidnight = new Date(now);
    nextMidnight.setHours(24, 0, 0, 0);      // 00:00 tomorrow, local
    // A couple of seconds past the boundary, so the new day is unambiguous.
    const wait = Math.max(1000, nextMidnight.getTime() - now.getTime() + 2000);
    timer = setTimeout(() => {
      refreshIfRolledOver();
      scheduleNextMidnight();
    }, wait);
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    refreshIfRolledOver();
    scheduleNextMidnight();   // the pending timer may have been throttled
  });
  window.addEventListener("focus", refreshIfRolledOver);

  scheduleNextMidnight();
})();

// Enhance strength — how much of the AI upscale to keep. Applies to the NEXT
// enhance; it is a request parameter, not a canvas filter, so there is
// nothing to re-render on change.
const enhanceStrengthInput = document.getElementById("enhance-strength");
const enhanceStrengthHint = document.getElementById("enhance-strength-hint");
if (enhanceStrengthInput) {
  const describe = (v) =>
    v >= 90 ? `${v}% — full model output, sharpest but most artificial.`
    : v >= 60 ? `${v}% — lower this if faces look painted or plastic.`
    : v >= 25 ? `${v}% — mostly a clean resample, very natural.`
    : `${v}% — essentially no AI enhancement.`;
  enhanceStrengthInput.addEventListener("input", () => {
    state.enhanceStrength = Number(enhanceStrengthInput.value);
    if (enhanceStrengthHint) enhanceStrengthHint.textContent = describe(state.enhanceStrength);
  });
}
