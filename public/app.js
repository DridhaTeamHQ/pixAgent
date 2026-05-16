/* ── Pix Post Builder — Scrape + Edit ── */

const canvas = document.getElementById("post-canvas");
// `ctx` is `let` (not const) so renderToHighResCanvas() can temporarily swap
// it to an offscreen 2× context for export, without rewriting every draw
// function to take a ctx parameter.
let ctx = canvas.getContext("2d");
const screenCtx = ctx;   // permanent reference to the on-screen context

// Export supersampling factor. 2× gives 4K-class output for 16:9 (3840×2160)
// and 4K-tall for 9:16 (1840×3400), at the cost of larger PNG file size
// (~3× vs design-size). Bumping to 3 quadruples filesize for marginal gain.
const EXPORT_SCALE = 2;

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
  ctx = exportCtx;
  try {
    renderPoster();
  } finally {
    ctx = previous;
  }
  return exportCanvas;
}

const scrapeForm = document.getElementById("scrape-form");
const scrapeUrlInput = document.getElementById("scrape-url");
const scrapeButton = document.getElementById("scrape-btn");
const scrapeStatus = document.getElementById("scrape-status");
const downloadButton = document.getElementById("download-btn");

const editPanel = document.getElementById("edit-panel");
const imagePanel = document.getElementById("image-panel");
const headlineEdit = document.getElementById("headline-edit");
const imgOffsetX = document.getElementById("img-offset-x");
const imgOffsetY = document.getElementById("img-offset-y");
const imgResetBtn = document.getElementById("img-reset-btn");
const bgImageUpload = document.getElementById("bg-image-upload");
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
    /* 9:16 keeps a big bottomPadding (~400 px) because the preview
       engagement + nav bars occupy that band, and Stories/Reels platforms
       overlay their own UI in that zone in the published feed. */
    headline: { x: 64, bottomPadding: 400, maxWidth: 920 - 128, defaultSize: 49 },
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
  accent: "#7900d9",
  headline: "",
  mainImage: null,
  ready: false,
  imageOffset: { x: 0, y: 0 },
  imageZoom: 100,
  headlineStyle: "half-purple",
  fontSize: 0, // 0 = auto
  overlayOpacity: 100,
  logoX: 810,
  logoY: 80,
  logoSize: 110,
  logoImage: null,
  shortlyLogoImage: null,   // alt logo used when exporting for X
  useShortlyLogo: false,    // toggled by the X download handler
  secondLogoImage: null,
  tag: "none",       // "none" | "trending" | "breaking"
  tagImages: {},     // { trending: Image, breaking: Image }
  isDownloading: false,
  imageSelectionNonce: 0,

  /* ── Image filters (CSS-style values applied via ctx.filter) ── */
  filterBrightness: 100,    // 0–200 (100 = neutral)
  filterContrast:   100,    // 0–200
  filterSaturation: 100,    // 0–200
  filterBlur:       0,      // 0–20 px
  filterPreset:     "none", // identifier of the active preset chip, if any
};

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

// Wait for both Poppins AND Roboto Serif fonts to load before first render
document.fonts.ready.then(async () => {
  // Ensure Roboto Serif is loaded for headline rendering
  try {
    await document.fonts.load("600 49px 'Roboto Serif'");
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

function setWriteStatus(message, type) {
  if (!writeStatus) return;
  writeStatus.textContent = message || "";
  writeStatus.className = "status-text";
  if (type) writeStatus.classList.add(type);
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
  state.headline = text;
  headlineEdit.value = text;
  editPanel.hidden = false;
  imagePanel.hidden = false;
  renderPoster();
  scrollPreviewIntoViewIfMobile();
  closeSheetIfMobile();

  writeApplyBtn.disabled = true;
  setWriteStatus("Finding matching images...");
  await fetchStockImages(text, {
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
const postXBtn    = document.getElementById("post-x-btn");
const postXStatus = document.getElementById("post-x-status");

function setPostStatus(msg, kind) {
  if (!postXStatus) return;
  postXStatus.className = "status-text" + (kind ? ` ${kind}` : "");
  postXStatus.textContent = "";
  if (msg) postXStatus.append(msg);
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

if (postXBtn) postXBtn.addEventListener("click", () => {
  const headline = (state.headline || "").trim();
  if (!headline) {
    setPostStatus("Build a poster first.", "error");
    return;
  }

  postXBtn.disabled = true;
  setPostStatus("Preparing X download...");

  // Flag for clean export with the Shortly logo. Screen canvas is left
  // alone - the export happens on a 2x offscreen canvas via
  // renderToHighResCanvas, then we restore state and re-render screen.
  state.isDownloading = true;
  state.useShortlyLogo = true;

  try {
    const exportCanvas = renderToHighResCanvas(EXPORT_SCALE);
    const cropped = exportCanvasCroppedToContent(exportCanvas, {
      paddingBelow: 36   * EXPORT_SCALE,
      minHeight:    1100 * EXPORT_SCALE,
    });

    cropped.toBlob((blob) => {
      state.isDownloading = false;
      state.useShortlyLogo = false;
      renderPoster();

      if (!blob) {
        postXBtn.disabled = false;
        setPostStatus("Couldn't render image.", "error");
        return;
      }

      const blobUrl = URL.createObjectURL(blob);
      const dl = document.createElement("a");
      dl.href = blobUrl;
      dl.download = `${slugify(headline || "pix-post")}-x.png`;
      dl.click();
      setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
      postXBtn.disabled = false;
      setPostStatus("X-ready PNG downloaded.", "success");
    }, "image/png");
  } catch (error) {
    state.isDownloading = false;
    state.useShortlyLogo = false;
    renderPoster();
    postXBtn.disabled = false;
    setPostStatus("Couldn't render X download.", "error");
    console.error("X download failed:", error);
  }
});
downloadButton.addEventListener("click", () => {
  // Flag for clean export (no preview overlays). We DO NOT re-render the
  // screen canvas — the export happens entirely on a 2× offscreen canvas
  // via renderToHighResCanvas, then we restore state and re-render screen.
  state.isDownloading = true;

  const exportCanvas = renderToHighResCanvas(EXPORT_SCALE);

  exportCanvas.toBlob((blob) => {
    state.isDownloading = false;
    renderPoster();  // Restore preview

    if (!blob) {
      setStatus("Failed to generate high-quality export.", "error");
      return;
    }
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${slugify(state.headline || "pix-post")}.png`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 100);
  }, "image/png");
});

// Headline live edit
headlineEdit.addEventListener("input", () => {
  state.headline = headlineEdit.value;
  writeHeadline.value = headlineEdit.value;
  renderPoster();
});

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
  state.imageZoom = Number(imgZoom.value);
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
bgImageUpload.addEventListener("change", (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  const uploadNonce = claimImageSelection();
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
      setStatus("Custom image loaded!", "success");
      bgImageUpload.value = "";
    };
    img.src = ev.target.result;
  };
  reader.readAsDataURL(file);
});

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
  state.imageOffset.x = clamp(dragOffsetStart.x + dx, -500, 500);
  state.imageOffset.y = clamp(dragOffsetStart.y + dy, -500, 500);
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
  state.imageOffset.x = clamp(dragOffsetStart.x + dx, -500, 500);
  state.imageOffset.y = clamp(dragOffsetStart.y + dy, -500, 500);
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
    state.ready = true;

    // Reset offsets
    state.imageOffset = { x: 0, y: 0 };
    imgOffsetX.value = 0;
    imgOffsetY.value = 0;

    // Populate edit panel
    headlineEdit.value = payload.title || "";
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
    setStatus(`Done! Poster ready — edit below, then download.`, "success");

    // Fetch recommended stock images in the background
    fetchStockImages(payload.title);
  } catch (error) {
    setStatus(error.message || "Unable to scrape that article.", "error");
  } finally {
    scrapeButton.disabled = false;
    scrapeButton.classList.remove("loading");
  }
}

async function fetchStockImages(headline, options = {}) {
  const { autoApplyFirst = false, onStatus = null } = options;
  const selectionNonceAtStart = state.imageSelectionNonce;
  const report = (message, type) => {
    if (typeof onStatus === "function") onStatus(message, type);
  };

  try {
    // 1. Extract proper search keywords from the headline instead of passing a long sentence
    const STOP = new Set(["THE", "A", "AN", "AND", "OR", "BUT", "FOR", "WITH", "FROM", "THAT", "THIS",
      "WILL", "WOULD", "SHOULD", "COULD", "SAYS", "SAID", "AFTER", "BEFORE", "ABOUT",
      "HAVE", "HAS", "HAD", "WAS", "WERE", "ARE", "IS", "BEEN", "INTO", "OVER", "UNDER",
      "THEIR", "THEY", "THEM", "THERE", "THEN", "MORE", "MOST", "VERY", "JUST", "ALSO",
      "NEW", "NEWS", "LIVE", "WHAT", "WHEN", "WHERE", "WHO", "HOW", "WHY", "WHICH", "AMID", "IN", "ON"]);

    // Extract alphanumeric words, uppercase
    const words = headline.toUpperCase().replace(/[^A-Z0-9\s]/g, "").split(/\s+/).filter(Boolean);
    const keywords = words.filter(w => !STOP.has(w) && w.length > 2).slice(0, 5); // Take top 5 meaningful words

    // Fallback to exactly 40 chars of the headline if keyword extraction fails
    const searchQuery = keywords.length > 0 ? keywords.join(" ") : headline.slice(0, 40);

    let images = [];

    // 2. Try Web / News Images first (Bing -> Google -> DDG)
    try {
      const gRes = await fetch(`/api/google-images?query=${encodeURIComponent(searchQuery)}`);
      const gData = await gRes.json();
      if (gRes.ok && gData.images?.length) {
        images = gData.images;
      }
    } catch { /* Web images failed, try Stock Pexels */ }

    // 3. Fallback to Pexels if web photos returned nothing
    if (!images.length) {
      try {
        const pRes = await fetch(`/api/stock-images?query=${encodeURIComponent(searchQuery)}`);
        const pData = await pRes.json();
        if (pRes.ok && pData.images?.length) {
          images = pData.images;
        }
      } catch { /* Pexels also failed */ }
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
    const applySuggestedImage = async (img, thumb = null, expectedNonce = null) => {
      if (expectedNonce !== null && state.imageSelectionNonce !== expectedNonce) {
        return false;
      }
      report("Loading selected image...");
      setStatus("Loading image...");
      try {
        const fullImg = await imageFromUrl(img.imageProxy);
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
        report("Failed to load that image.", "error");
        setStatus("Failed to load image.", "error");
        return false;
      }
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

    if (autoApplyFirst && images[0] && state.imageSelectionNonce === selectionNonceAtStart) {
      const applied = await applySuggestedImage(images[0], thumbs[0], selectionNonceAtStart);
      if (applied) {
        report(`Poster ready with a matching image. ${images.length > 1 ? "Tap another thumbnail to change it." : ""}`.trim(), "success");
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
  const top = Math.max(0, canvas.height - L.headline.bottomPadding - blockHeight);
  return { layout, top, fontSize, blockHeight };
}

function renderPoster() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";

  // Compute headline layout + bottom-anchored top ONCE for this render and
  // share via state._render so drawBackground / drawTag / drawHeadline don't
  // each have to recompute the same thing.
  state._render = computeHeadlineLayoutAndTop();

  drawBackground();
  drawHero();
  drawTag();
  drawHeadline();

  // Preview-only UI elements (not included in download).
  // Only the 9:16 preset shows the Reels-style engagement + nav bars; on
  // square / wide / 4:5 ratios these mockups don't make visual sense.
  if (!state.isDownloading && getLayout().showPreviewBars) {
    drawEngagementBar();
    drawNavBar();
  }
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
  const useAlt = state.useShortlyLogo && state.shortlyLogoImage;
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
  ctx.save();
  if (glow) {
    // Soft white halo to make the Pix logo pop against dark backgrounds.
    // Skipped for the Shortly logo, which carries its own gradient circle.
    ctx.shadowColor = "rgba(255, 255, 255, 0.5)";
    ctx.shadowBlur = 18;
  }
  ctx.drawImage(img, x, y, w, h);
  ctx.shadowBlur = 0;
  ctx.restore();
}

function drawTag() {
  if (state.tag === "none") return;
  const tagImg = state.tagImages[state.tag];
  if (!tagImg) return;

  // Tag is anchored to the dynamic headline top, so it always sits just
  // above the headline regardless of how many lines the headline wrapped to.
  const L = getLayout();
  const drawW = tagImg.naturalWidth || tagImg.width;
  const drawH = tagImg.naturalHeight || tagImg.height;
  const tagX = L.tag.x;
  const headlineTop = state._render?.top ?? (canvas.height - L.headline.bottomPadding - 200);
  const tagY = headlineTop - drawH - L.tag.gapAboveHeadline;

  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.3)";
  ctx.shadowBlur = 12;
  ctx.drawImage(tagImg, tagX, tagY, drawW, drawH);
  ctx.shadowBlur = 0;
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
      // Purple circle
      ctx.beginPath();
      ctx.arc(cx, cy, 40, 0, Math.PI * 2);
      ctx.fillStyle = "#7900d9";
      ctx.fill();
    }

    const iconSize = isAccent ? 40 : 44;
    drawIconPath(cx, cy, iconSize, path, isAccent);
  });

  ctx.restore();
}

function buildHeadlineLayoutFixed(text, maxWidth, size) {
  const cleaned = normalizeHeadlineForPoster(text);
  const words = cleaned.trim().split(/\s+/).filter(Boolean);
  const font = `600 ${size}px 'Roboto Serif', 'Poppins', serif`;
  ctx.font = font;
  const lines = wrapWords(words, maxWidth);
  return { font, lines, lineHeight: Math.round(size * 1.1) };
}

/* ── Headline Layout ── */

function buildHeadlineLayout(text, maxWidth, _maxLines) {
  const cleaned = normalizeHeadlineForPoster(text);
  const words = cleaned.trim().split(/\s+/).filter(Boolean);

  // Fixed 48px / 600 weight — text grows downward as lines increase
  const size = 48;
  const font = `600 ${size}px 'Roboto Serif', 'Poppins', serif`;
  ctx.font = font;
  const lines = wrapWords(words, maxWidth);
  return { font, lines, lineHeight: Math.round(size * 1.22) };
}

function normalizeHeadlineForPoster(text) {
  return text
    .replace(/\s+/g, " ")
    .replace(/^live\s+/i, "")
    .trim();
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
  const scale = baseScale * (zoom || 1);
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

function slugify(value) {
  return (value || "pix-post").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "pix-post";
}

function setStatus(message, type) {
  scrapeStatus.textContent = message;
  scrapeStatus.className = "status-text";
  if (type) scrapeStatus.classList.add(type);
}
