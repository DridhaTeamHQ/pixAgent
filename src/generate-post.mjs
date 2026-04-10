import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const [, , configArg = "config/sample-post.json"] = process.argv;
const configPath = resolve(process.cwd(), configArg);
const configDir = dirname(configPath);
const config = JSON.parse(readFileSync(configPath, "utf8"));

const width = config.width ?? 1080;
const height = config.height ?? 1920;
const outputDir = resolve(process.cwd(), config.outputDir ?? "output");
const slug = slugify(config.name ?? "post");
const htmlPath = join(outputDir, `${slug}.html`);
const pngPath = join(outputDir, `${slug}.png`);

mkdirSync(outputDir, { recursive: true });

const accent = config.accentColor ?? "#8b5cf6";
const brand = config.brandName ?? "Pix";
const headline = config.headline ?? "YOUR HEADLINE GOES HERE";
const mainImage = resolveImageSource(config.mainImage, configDir, buildMainPlaceholder(width, Math.round(height * 0.66), accent));
const logoImage = resolveImageSource(config.logoImage, configDir, buildLogoPlaceholder(160, 160, brand, accent));

const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(config.name ?? "Generated Post")}</title>
  <style>
    :root {
      --bg: #050505;
      --panel: #0d0d13;
      --text: #ffffff;
      --accent: ${escapeHtml(accent)};
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body {
      width: 100vw;
      height: 100vh;
      margin: 0;
      padding: 0;
      background: #050505;
      font-family: "Segoe UI", Arial, sans-serif;
      color: #ffffff;
      overflow: hidden;
    }

    .frame {
      position: fixed;
      top: 0; left: 0;
      width: 100vw;
      height: 100vh;
      overflow: hidden;
      background-color: #050505;
      background-image: url('${mainImage}');
      background-size: cover;
      background-position: center center;
      background-repeat: no-repeat;
    }

    .overlay {
      position: absolute;
      inset: 0;
      background: rgba(0,0,0,0);
      z-index: 1;
    }

    .brand-logo {
      position: absolute;
      top: 40px;
      right: 40px;
      width: 132px;
      height: 132px;
      border-radius: 50%;
      background: white;
      display: grid;
      place-items: center;
      overflow: hidden;
      box-shadow: 0 12px 30px rgba(0, 0, 0, 0.35);
      z-index: 5;
    }

    .brand-logo img {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }

    .headline-wrap {
      position: absolute;
      left: 60px;
      right: 60px;
      bottom: 60px;
      z-index: 5;
    }

    .headline {
      margin: 0;
      font-weight: 900;
      font-size: 76px;
      line-height: 1.05;
      letter-spacing: -0.03em;
      text-transform: uppercase;
      text-wrap: balance;
      color: #fff;
    }

    .headline .accent { color: var(--accent); }
  </style>
</head>
<body>
  <main class="frame">
    <div class="overlay"></div>

    <div class="brand-logo">
      <img src="${logoImage}" alt="Brand logo" />
    </div>

    <section class="headline-wrap">
      <h1 class="headline">${buildHeadlineHtml(headline)}</h1>
    </section>
  </main>
</body>
</html>`;

writeFileSync(htmlPath, html, "utf8");
renderPng(htmlPath, pngPath, width, height);

console.log(`HTML written to ${htmlPath}`);
console.log(`PNG written to ${pngPath}`);

function buildHeadlineHtml(text) {
  const words = text.trim().split(/\s+/);
  // Pick max 4 words for the top highlighted line
  const accentCount = Math.min(words.length - 1, 4);
  const first = escapeHtml(words.slice(0, accentCount).join(" "));
  const second = escapeHtml(words.slice(accentCount).join(" "));

  if (!second) {
    return `<span class="accent">${first}</span>`;
  }

  // Force a line break so the purple is guaranteed to be one complete visual line
  return `<span class="accent">${first}</span><br />${second}`;
}

function resolveImageSource(value, baseDir, fallbackSvg) {
  if (!value) {
    return svgToDataUri(fallbackSvg);
  }

  if (/^data:/i.test(value) || /^https?:\/\//i.test(value)) {
    return value;
  }

  const filePath = isAbsolute(value) ? value : resolve(baseDir, value);
  if (!existsSync(filePath)) {
    return svgToDataUri(fallbackSvg);
  }

  const ext = extname(filePath).toLowerCase();
  const mime = ({
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".svg": "image/svg+xml"
  }[ext] ?? "application/octet-stream");

  const encoded = readFileSync(filePath).toString("base64");
  return `data:${mime};base64,${encoded}`;
}

function renderPng(sourceHtmlPath, targetPngPath, viewportWidth, viewportHeight) {
  const edgePath = detectEdge();
  if (!edgePath) {
    throw new Error("Microsoft Edge was not found. Update detectEdge() with your browser path.");
  }

  const fileUrl = `file:///${sourceHtmlPath.replace(/\\/g, "/")}`;
  const result = spawnSync(edgePath, [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--hide-scrollbars",
    "--force-device-scale-factor=1",
    "--default-background-color=00000000",
    "--disable-features=UseZoomForDSF",
    "--run-all-compositor-stages-before-draw",
    "--virtual-time-budget=5000",
    `--window-size=${viewportWidth},${viewportHeight}`,
    `--screenshot=${targetPngPath}`,
    fileUrl
  ], { stdio: "pipe", encoding: "utf8" });

  if (result.status !== 0) {
    throw new Error(result.stderr || "Edge failed to render the PNG.");
  }
}

function detectEdge() {
  const candidates = [
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"
  ];

  return candidates.find((candidate) => existsSync(candidate));
}

function slugify(input) {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "post";
}

function escapeHtml(value) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;").replace(/'/g, "&#39;");
}

function svgToDataUri(svg) {
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

function buildMainPlaceholder(svgWidth, svgHeight, accentColor) {
  return `
  <svg xmlns="http://www.w3.org/2000/svg" width="${svgWidth}" height="${svgHeight}" viewBox="0 0 ${svgWidth} ${svgHeight}">
    <defs>
      <linearGradient id="bg" x1="0" x2="1" y1="0" y2="1">
        <stop offset="0%" stop-color="#1b2849" />
        <stop offset="55%" stop-color="#0e1831" />
        <stop offset="100%" stop-color="#05070f" />
      </linearGradient>
    </defs>
    <rect width="100%" height="100%" fill="url(#bg)" />
    <circle cx="${Math.round(svgWidth * 0.5)}" cy="${Math.round(svgHeight * 0.55)}" r="${Math.round(svgHeight * 0.2)}" fill="#e4c1a1" />
    <rect x="${Math.round(svgWidth * 0.3)}" y="${Math.round(svgHeight * 0.43)}" width="${Math.round(svgWidth * 0.42)}" height="${Math.round(svgHeight * 0.45)}" rx="24" fill="#16274f" />
    <rect x="${Math.round(svgWidth * 0.42)}" y="${Math.round(svgHeight * 0.44)}" width="${Math.round(svgWidth * 0.22)}" height="${Math.round(svgHeight * 0.18)}" rx="24" fill="#1f3569" />
    <path d="M${Math.round(svgWidth * 0.2)} ${Math.round(svgHeight * 0.18)} H${Math.round(svgWidth * 0.95)}" stroke="${accentColor}" stroke-width="18" stroke-linecap="round" opacity="0.92" />
    <path d="M${Math.round(svgWidth * 0.64)} ${Math.round(svgHeight * 0.63)} C${Math.round(svgWidth * 0.82)} ${Math.round(svgHeight * 0.58)}, ${Math.round(svgWidth * 0.84)} ${Math.round(svgHeight * 0.82)}, ${Math.round(svgWidth * 0.88)} ${Math.round(svgHeight * 0.95)}" stroke="#111827" stroke-width="20" fill="none" stroke-linecap="round" />
  </svg>`;
}

function buildInsetPlaceholder(svgWidth, svgHeight, accentColor) {
  return `
  <svg xmlns="http://www.w3.org/2000/svg" width="${svgWidth}" height="${svgHeight}" viewBox="0 0 ${svgWidth} ${svgHeight}">
    <rect width="100%" height="100%" fill="#99bfd9" />
    <rect x="24" y="140" width="220" height="70" rx="12" fill="#64748b" />
    <rect x="188" y="112" width="42" height="80" rx="8" fill="#cbd5e1" />
    <path d="M0 220 C90 170, 190 250, 320 170 V320 H0 Z" fill="#2563eb" opacity="0.55" />
    <circle cx="90" cy="92" r="18" fill="${accentColor}" opacity="0.85" />
  </svg>`;
}

function buildLogoPlaceholder(svgWidth, svgHeight, brandText, accentColor) {
  return `
  <svg xmlns="http://www.w3.org/2000/svg" width="${svgWidth}" height="${svgHeight}" viewBox="0 0 ${svgWidth} ${svgHeight}">
    <rect width="100%" height="100%" rx="${svgWidth / 2}" fill="#ffffff" />
    <text x="50%" y="56%" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="54" font-weight="800" fill="${accentColor}">${escapeXml(brandText)}</text>
  </svg>`;
}

function escapeXml(value) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;").replace(/'/g, "&apos;");
}