/* ── Pix Post Builder — Scrape + Edit ── */

const canvas = document.getElementById("post-canvas");
const ctx = canvas.getContext("2d");

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

/* ── State ── */

const state = {
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
  useShortlyLogo: false,    // toggled by Post to X handler
  secondLogoImage: null,
  tag: "none",       // "none" | "trending" | "breaking"
  tagImages: {},     // { trending: Image, breaking: Image }
  isDownloading: false
};

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

// Alt logo used only when exporting for X (Post to X button).
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

// Write mode — build poster from manual text
writeApplyBtn.addEventListener("click", () => {
  const text = writeHeadline.value.trim();
  if (!text) return;
  state.headline = text;
  headlineEdit.value = text;
  editPanel.hidden = false;
  imagePanel.hidden = false;
  renderPoster();
});

// Live sync: write-headline → headline-edit → poster
writeHeadline.addEventListener("input", () => {
  state.headline = writeHeadline.value;
  headlineEdit.value = writeHeadline.value;
  renderPoster();
});

scrapeForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await runScrape();
});

/* ── Post to X ── */
const postXBtn    = document.getElementById("post-x-btn");
const postXStatus = document.getElementById("post-x-status");

function setPostStatus(msg, kind) {
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
  const fallback = headline.replace(/\[|\]/g, "").trim().slice(0, 280);
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

postXBtn.addEventListener("click", () => {
  const headline = (state.headline || "").trim();
  if (!headline) {
    setPostStatus("Build a poster first.", "error");
    return;
  }

  postXBtn.disabled = true;
  setPostStatus("Generating caption with AI…");

  // Render clean export with the SHORTLY logo (only for the X-bound PNG)
  state.isDownloading = true;
  state.useShortlyLogo = true;
  renderPoster();

  // Two parallel async operations:
  //   1. Render canvas → cropped blob (fast, ~50ms)
  //   2. Call OpenAI for an AI-written caption + hashtags (~1–2s)
  const blobPromise = new Promise((resolve) => {
    // Crop the trailing black gradient gap before exporting so the X feed
    // doesn't show a tall band of black under the headline.
    const cropped = exportCanvasCroppedToContent(canvas, { paddingBelow: 36, minHeight: 1100 });
    cropped.toBlob((b) => {
      // Restore preview state: Pix logo + overlays back on
      state.isDownloading = false;
      state.useShortlyLogo = false;
      renderPoster();
      resolve(b);
    }, "image/png");
  });
  const captionPromise = fetchAiCaption(headline);

  (async () => {
    // 1) COPY TO CLIPBOARD FIRST — must happen while this tab is focused.
    //    ClipboardItem accepts a Promise<Blob>, which preserves the user
    //    gesture chain better than awaiting the blob outright.
    let clipboardOk = false;
    try {
      if (navigator.clipboard && window.ClipboardItem) {
        await navigator.clipboard.write([
          new ClipboardItem({ "image/png": blobPromise })
        ]);
        clipboardOk = true;
      }
    } catch (e) {
      console.warn("Clipboard write failed:", e);
    }

    const blob = await blobPromise;
    if (!blob) {
      postXBtn.disabled = false;
      setPostStatus("Couldn't render image.", "error");
      return;
    }

    // 2) Wait for AI caption (already in flight), then open X with it
    setPostStatus("Opening X…");
    const { caption, source, error } = await captionPromise;
    const intentUrl = `https://x.com/intent/post?text=${encodeURIComponent(caption)}`;
    const win = window.open(intentUrl, "_blank", "noopener,noreferrer");

    // 3) Status — surface AI failures clearly so we can debug
    postXStatus.textContent = "";
    if (source === "ai") {
      postXStatus.className = "status-text success";
      postXStatus.append(
        clipboardOk
          ? "✓ AI caption written, image copied — Ctrl+V on the X tab."
          : "⚠ AI caption written but couldn't access clipboard — allow clipboard permission and retry."
      );
    } else {
      // AI failed — make it visible
      postXStatus.className = "status-text error";
      postXStatus.append(`⚠ AI caption failed (${error || "unknown"}) — used raw headline. `);
    }
    if (!win) {
      const a = document.createElement("a");
      a.href = intentUrl; a.target = "_blank"; a.rel = "noopener";
      a.textContent = "Open X →";
      postXStatus.append(a);
    }

    postXBtn.disabled = false;
  })();
});

downloadButton.addEventListener("click", () => {
  // Render WITHOUT UI overlays for clean export
  state.isDownloading = true;
  renderPoster();

  // Use toBlob instead of toDataURL to prevent browser limits on large base64 strings which can downgrade quality
  canvas.toBlob((blob) => {
    if (!blob) {
      setStatus("Failed to generate high-quality export.", "error");
      return;
    }
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${slugify(state.headline || "pix-post")}.png`;
    link.click();

    // Cleanup URL immediately to save memory
    setTimeout(() => URL.revokeObjectURL(url), 100);

    // Re-render WITH overlays for preview
    state.isDownloading = false;
    renderPoster();
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
  state.imageOffset = { x: 0, y: 0 };
  state.imageZoom = 100;
  imgOffsetX.value = 0;
  imgOffsetY.value = 0;
  imgZoom.value = 100;
  renderPoster();
});

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

// Background image upload
bgImageUpload.addEventListener("change", (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async (ev) => {
    const img = new Image();
    img.onload = async () => {
      await ensureImageFocalPoint(img);
      state.mainImage = img;
      state.imageOffset = { x: 0, y: 0 };
      imgOffsetX.value = 0;
      imgOffsetY.value = 0;
      editPanel.hidden = false;
      imagePanel.hidden = false;
      renderPoster();
      setStatus("Custom image loaded!", "success");
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

async function fetchStockImages(headline) {
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
      stockImagesSection.hidden = true;
      return;
    }

    stockImagesGrid.innerHTML = "";
    images.forEach(img => {
      const thumb = document.createElement("div");
      thumb.className = "stock-item";
      thumb.style.backgroundImage = `url(${img.preview})`;
      thumb.title = img.alt || "Related image";
      thumb.addEventListener("click", async () => {
        setStatus("Loading image...");
        try {
          const fullImg = await imageFromUrl(img.imageProxy);
          await ensureImageFocalPoint(fullImg);
          state.mainImage = fullImg;
          state.imageOffset = { x: 0, y: 0 };
          state.imageZoom = 100;
          imgOffsetX.value = 0;
          imgOffsetY.value = 0;
          imgZoom.value = 100;
          renderPoster();
          setStatus("Image applied!", "success");
          stockImagesGrid.querySelectorAll(".stock-item").forEach(t => t.classList.remove("active"));
          thumb.classList.add("active");
        } catch {
          setStatus("Failed to load image.", "error");
        }
      });
      stockImagesGrid.appendChild(thumb);
    });

    stockImagesSection.hidden = false;
  } catch {
    stockImagesSection.hidden = true;
  }
}

/* ── Poster Rendering ── */

function renderPoster() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";

  drawBackground();
  drawHero();
  drawTag();
  drawHeadline();

  // Preview-only UI elements (not included in download)
  if (!state.isDownloading) {
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

  // Smooth gradient: starts at y=800, fully black by ~y=1150
  // This matches the Zeplin reference where the fade is gradual through the mid-section
  const gradientStart = 800;
  const gradientHeight = canvas.height - gradientStart;  // 900px
  const grad = ctx.createLinearGradient(0, gradientStart, 0, canvas.height);
  grad.addColorStop(0, `rgba(0,0,0,0)`);
  grad.addColorStop(0.12, `rgba(0,0,0,${(0.10 * opa).toFixed(2)})`);
  grad.addColorStop(0.22, `rgba(0,0,0,${(0.30 * opa).toFixed(2)})`);
  grad.addColorStop(0.30, `rgba(0,0,0,${(0.55 * opa).toFixed(2)})`);
  grad.addColorStop(0.38, `rgba(0,0,0,${(0.80 * opa).toFixed(2)})`);
  grad.addColorStop(0.44, `rgba(0,0,0,${(0.95 * opa).toFixed(2)})`);
  grad.addColorStop(0.50, `rgba(0,0,0,${(1.00 * opa).toFixed(2)})`);
  grad.addColorStop(1, `rgba(0,0,0,${(1.00 * opa).toFixed(2)})`);
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

  // Shortly logo gets a slightly larger slot for visibility in X feeds.
  // Pix logo keeps the original 100×100 slot so the live preview is unchanged.
  const slotSize = useAlt ? 130 : 100;

  // Both logos share the same visual center (the original Pix slot's center).
  // Original Pix slot: top-left (760, 100), 100×100 → center (810, 150).
  const centerX = 810;
  const centerY = 150;

  const rawW = logo.naturalWidth  || logo.width  || 1;
  const rawH = logo.naturalHeight || logo.height || 1;

  // Scale so the longest edge fills the slot (preserves aspect ratio)
  const scale = slotSize / Math.max(rawW, rawH);
  const drawW = rawW * scale;
  const drawH = rawH * scale;

  // Center inside the slot
  const px = centerX - drawW / 2;
  const py = centerY - drawH / 2;

  drawLogoAt(logo, px, py, drawW, drawH);
}

function drawLogoAt(img, x, y, w, h) {
  ctx.save();
  // Light shadow effect (soft white glow) to make the logo pop against dark backgrounds
  ctx.shadowColor = "rgba(255, 255, 255, 0.5)";
  ctx.shadowBlur = 18;
  ctx.drawImage(img, x, y, w, h);
  ctx.shadowBlur = 0;
  ctx.restore();
}

function drawTag() {
  if (state.tag === "none") return;
  const tagImg = state.tagImages[state.tag];
  if (!tagImg) return;

  // Zeplin: tag at native SVG size (156×37 or 155×37), left at x=64
  const drawW = tagImg.naturalWidth || tagImg.width;
  const drawH = tagImg.naturalHeight || tagImg.height;
  const tagX = 64;
  const tagY = 1130 - drawH - 16;  // 16px gap above headline (Zeplin spec)

  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.3)";
  ctx.shadowBlur = 12;
  ctx.drawImage(tagImg, tagX, tagY, drawW, drawH);
  ctx.shadowBlur = 0;
  ctx.restore();
}

function drawHeadline() {
  const text = state.headline || "YOUR HEADLINE HERE";
  // Zeplin: headline at x=64, max width = 920 - 64 - 64 = 792px
  const maxTextWidth = canvas.width - 128;
  const layout = state.fontSize > 0
    ? buildHeadlineLayoutFixed(text, maxTextWidth, state.fontSize)
    : buildHeadlineLayout(text, maxTextWidth, 5);
  const left = 64;
  const blockHeight = layout.lines.length * layout.lineHeight;
  // Zeplin: headline Y = 1130
  const top = 1130;

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
      const isOpening = rawWord.includes('[');
      const isClosing = rawWord.includes(']');
      const cleanWord = rawWord.replace(/[\[\]]/g, '');

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
    const PADDING = 8;

    segments.forEach(seg => {
      const drawX = seg.x - PADDING;
      const widthToFill = seg.w + PADDING * 2;

      const drawY = y + 4;
      const drawH = layout.lineHeight - 6; // Creates a vertical gap between lines
      const radius = 8; // Soft rounded corners

      ctx.beginPath();
      // Use standard roundRect
      ctx.roundRect(drawX, drawY, widthToFill, drawH, radius);
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
      const cleanWord = rawWord.replace(/[\[\]]/g, '');
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
    if (ctx.measureText(test.replace(/[\[\]]/g, '')).width <= maxWidth) {
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
    if (ctx.measureText(moved.replace(/[\[\]]/g, '')).width <= maxWidth * 0.98) {
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

  ctx.drawImage(image, dx, dy, drawWidth, drawHeight);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/* ── Image Utilities ── */

async function imageFromUrl(url) {
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
