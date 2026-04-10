import axios from "axios";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";

const NEWS_API_KEY = "07da87ceacac4ec6819e59ab5e9de28b";
const [, , sourceArg = "bbc"] = process.argv;

// Download image and convert to base64 data URI so Edge always renders it
async function downloadImageAsBase64(url) {
    try {
        if (!url) return "";
        const { data, headers } = await axios.get(url, {
            responseType: "arraybuffer",
            timeout: 10000,
            headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" }
        });
        const mime = headers["content-type"]?.split(";")[0] || "image/jpeg";
        const b64 = Buffer.from(data).toString("base64");
        return `data:${mime};base64,${b64}`;
    } catch (e) {
        console.warn("Could not download image:", e.message);
        return url; // fallback to original URL
    }
}

// Map of sources to NewsAPI query parameters
const SOURCES = {
    bbc: {
        label: "BBC News",
        params: { sources: "bbc-news" }
    },
    toi: {
        label: "Times of India",
        params: { country: "in", language: "en" }
    },
    indiatoday: {
        label: "India Today",
        params: { country: "in", language: "en", q: "india" }
    },
    aajtak: {
        label: "Aaj Tak",
        params: { country: "in" }
    }
};

async function fetchTopArticle(sourceId) {
    const source = SOURCES[sourceId];
    if (!source) {
        throw new Error(`Unknown source: ${sourceId}. Available: ${Object.keys(SOURCES).join(", ")}`);
    }

    console.log(`Fetching top story from ${source.label} via NewsAPI...`);

    const { data } = await axios.get("https://newsapi.org/v2/top-headlines", {
        params: {
            ...source.params,
            apiKey: NEWS_API_KEY,
            pageSize: 10
        }
    });

    if (data.status !== "ok" || !data.articles || data.articles.length === 0) {
        throw new Error(`NewsAPI returned no articles: ${data.message || "unknown error"}`);
    }

    // Pick first article with both a title and an image
    const article = data.articles.find(a => a.title && a.urlToImage) || data.articles[0];

    let headline = article.title || "";
    const image = article.urlToImage || "";

    // Clean up headline
    headline = headline.split(" | ")[0].split(" - ")[0].trim();
    headline = headline.replace(/\?+$/, "");                                            // strip trailing ?
    headline = headline.replace(/^(How|Why|What|When|Where|Who|Is|Are|Was|Were|Can|Does|Did)\s+/i, ""); // strip question starters

    // Truncate to max 10 words for punchy look
    const words = headline.split(" ");
    if (words.length > 10) headline = words.slice(0, 10).join(" ") + "...";

    console.log("\n--- Extracted Data ---");
    console.log("Headline:", headline);
    console.log("Image URL:", image);

    return { headline, image };
}

async function main() {
    const sourceId = sourceArg.toLowerCase();
    const article = await fetchTopArticle(sourceId);

    console.log("\nDownloading image...");
    const embeddedImage = await downloadImageAsBase64(article.image);

    const config = {
        name: `scraped-${sourceId}-post`,
        headline: article.headline,
        kicker: "Breaking News",
        brandName: "Pix",
        accentColor: "#8b5cf6",
        mainImage: embeddedImage,
        logoImage: "",
        outputDir: "output"
    };

    const outPath = resolve(process.cwd(), "config", "scraped-post.json");
    const outDir = dirname(outPath);
    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

    writeFileSync(outPath, JSON.stringify(config, null, 2), "utf8");
    console.log(`\nSuccess! Created config at ${outPath}`);
    console.log("Now run: npm run generate config/scraped-post.json");
}

main().catch(err => {
    console.error("Error:", err.message);
    process.exit(1);
});
