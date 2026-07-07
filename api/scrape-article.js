import { USER_AGENT, setCors, handlePreflight } from "../lib/http.js";
import {
  extractMetaContent,
  stripTags,
  cleanupText,
  resolveMaybeRelative,
  upgradeImageToHighestQuality,
} from "../lib/scrape.js";

const TEXT_DETAIL_CHAR_LIMIT = 500;

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  setCors(res);

  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed." });
    return;
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const targetUrl = body?.url;

    if (!targetUrl) {
      res.status(400).json({ error: "A URL is required." });
      return;
    }

    const parsedUrl = new URL(targetUrl);
    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
      res.status(400).json({ error: "Only http and https URLs are supported." });
      return;
    }

    const response = await fetch(parsedUrl, { headers: { "user-agent": USER_AGENT } });
    if (!response.ok) {
      res.status(502).json({ error: `Source returned ${response.status}.` });
      return;
    }
    const html = await response.text();

    // Title: og:title > twitter:title > <title> tag
    let title = extractMetaContent(html, ["og:title", "twitter:title"]);
    if (!title) {
      const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      title = titleMatch ? cleanupText(stripTags(titleMatch[1])) : "";
    }
    title = cleanupText(stripTags(title));
    title = title.replace(/\s*[-|–—]\s*[^-|–—]{2,30}$/i, "").trim();

    // Image: og:image:secure_url > og:image > twitter:image
    let image = extractMetaContent(html, ["og:image:secure_url", "og:image", "twitter:image", "twitter:image:src"]);
    if (image) {
      image = resolveMaybeRelative(image, targetUrl);
      image = upgradeImageToHighestQuality(image);
    }

    if (!title) {
      res.status(422).json({ error: "Could not extract a title from this page." });
      return;
    }

    const metaDescription = extractMetaContent(html, ["og:description", "twitter:description", "description"]);
    const articleText = extractArticleText(html, title);

    // Entity-focused image search query via gpt-4o-mini (fail-soft). The old
    // client-side keyword extractor produced garbage like "KARAN JOHARS
    // DHARMA PRODUCTIONS SEALS" → sports photos for a Bollywood story.
    const imageQuery = await buildImageSearchQuery(title, articleText);

    res.status(200).json({
      title: cleanupText(title),
      image: image || null,
      imageProxy: image ? `/api/image?url=${encodeURIComponent(image)}` : null,
      sourceUrl: targetUrl,
      articleText,
      detailText: limitCharacters(articleText || metaDescription || title, TEXT_DETAIL_CHAR_LIMIT),
      imageQuery,
    });
  } catch (err) {
    res.status(500).json({ error: err.message || "Article scrape failed." });
  }
}

/* Ask gpt-4o-mini for a 3-6 word image-search query: the names/entities a
   photo editor would search for. ~$0.0001, fails soft to "". */
async function buildImageSearchQuery(title, articleText = "") {
  const apiKey = process.env.OPENAI_API_KEY || "";
  if (!apiKey || !title) return "";
  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
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
    return q.slice(0, 80);
  } catch {
    return "";
  }
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
    const key = normalizeParagraphText(text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const score = scoreArticleParagraph(text, title);
    if (score > 0) candidates.push({ text, score });
  }
  return candidates;
}

function scoreArticleParagraph(text, title = "") {
  const normalized = normalizeParagraphText(text);
  const words = normalized.split(/\s+/).filter(Boolean);
  if (text.length < 45 || text.length > 1200 || words.length < 8) return 0;
  if (title && normalizeParagraphText(title) === normalized) return 0;
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

function normalizeParagraphText(value) {
  return (value || "").toLowerCase().replace(/\s+/g, " ").trim();
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
