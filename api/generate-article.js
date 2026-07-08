// AI article writer — gpt-4o-mini, JSON mode.
// Takes { headline, sourceUrl? } and returns:
//   { headline, bullets: [4 strings], tweet, flags: [notes] }
// following the Shortly editorial format & safety rules.

import { USER_AGENT, setCors, handlePreflight } from "../lib/http.js";
import { stripTags, cleanupText } from "../lib/scrape.js";

export const EDITORIAL_SYSTEM_PROMPT = [
  "You are a news sub-editor at Shortly. Given a source headline (and article text when available), produce a news package in STRICT JSON with this exact shape:",
  "",
  '{ "headline": string, "bullets": [string, string, string, string], "tweet": string, "flags": [string] }',
  "",
  "FORMAT RULES:",
  "1. headline: max 60 characters. Newspaper style. Correct sentence capitalisation (capitalise first word and proper nouns only). No repeated phrases from the bullets. No periods in initials (write PM, US, UK — never P.M., U.S.).",
  "2. bullets: exactly 4 bullet points covering the most important parts of the news. Each bullet MUST be ONE complete, grammatical sentence that ends with a full stop and is 90 to 105 characters long including spaces. NEVER write a fragment or let a sentence trail off unfinished — if a point will not fit in 105 characters, say it more concisely rather than cutting it. Do not repeat the headline's phrasing.",
  "3. tweet: within 280 characters TOTAL including hashtags. No dashes of any kind. British English spelling (organise, colour, labour). Facts first — lead with what happened, not opinion. Write the sentence(s), then a line break, then the hashtags.",
  "4. hashtags: end every tweet with 5 to 7 hashtags. Each must be CamelCase with no spaces or punctuation (e.g. #AmitabhBachchan #AyodhyaLand #RealEstateIndia). Order them most-specific first: full person names and place/event names, then 2 to 3 broader topical tags for reach (e.g. #IndianPolitics, #Cricket, #Bollywood, #TechNews, #Markets). Do NOT use generic filler tags like #News, #Update, #Viral, #Trending, or #BreakingNews. No duplicate tags.",
  "",
  "EXAMPLE of correctly-formed bullets (each is ONE complete sentence, ends with a full stop, 90-105 characters — copy this style and length exactly):",
  '- "Abhinandan Lodha says Amitabh Bachchan wired Rs 15 crore for the Ayodhya land within a single day."',
  '- "The deal highlights rising celebrity investment in Ayodhya\'s fast-growing real estate market this year."',
  '- "Lodha shared the account in an interview, calling the actor\'s late-night decision unusually swift."',
  '- "Neither side has explained what Bachchan intends to build on the newly acquired Ayodhya plot."',
  "Notice how each example finishes its thought and never trails off. Do the same for every bullet.",
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

// Keep the tweet ≤280 chars, trimming at whitespace so a trailing hashtag
// is never cut mid-word.
function clampTweet(s) {
  s = String(s).replace(/[ \t]+\n/g, "\n").trim();
  if (s.length <= 280) return s;
  let cut = s.slice(0, 280);
  const sp = cut.lastIndexOf(" ");
  const nl = cut.lastIndexOf("\n");
  const boundary = Math.max(sp, nl);
  if (boundary > 240) cut = cut.slice(0, boundary);
  return cut.trim();
}

// A bullet is "good" when it's a complete sentence in the target band.
function bulletIsValid(b) {
  const t = String(b).trim();
  if (t.length < 60 || t.length > 108) return false;
  if (!/[.!?]["')\]]?$/.test(t)) return false;
  // Reject sentences that trail off on a function word (e.g. "...and.")
  const core = t.replace(/[.!?"')\]]+$/, "").trim();
  return !TRAILING_STOPWORDS.test(core);
}

// Self-repair pass: when the first generation returns bullets that overflow
// or read as fragments, ask gpt-4o-mini to rewrite ALL of them into complete
// sentences in-range. Cheap (~$0.0002), one extra call, only when needed.
// Returns 4 rewritten strings or null on any failure (caller keeps originals).
async function repairBullets(apiKey, headline, articleText, bullets) {
  const prompt =
    "Rewrite these news bullet points so EACH one is a single complete sentence that ends with a full stop and is between 90 and 105 characters long including spaces. Keep the same facts and meaning; add no new facts; do not let any sentence trail off. Return STRICT JSON: { \"bullets\": [4 strings] }.\n\n" +
    (headline ? `Headline: ${headline}\n` : "") +
    (articleText ? `Article: ${articleText.slice(0, 500)}\n` : "") +
    "Bullets to fix:\n" + bullets.map((b, i) => `${i + 1}. ${b}`).join("\n");
  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
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
    const b = Array.isArray(parsed.bullets) ? parsed.bullets.slice(0, 4).map((x) => String(x).replace(/\s+/g, " ").trim()) : null;
    return b && b.length === 4 && b.every(Boolean) ? b : null;
  } catch {
    return null;
  }
}

// Keep a bullet ≤105 chars WITHOUT ever cutting mid-sentence or mid-word.
// A tiny headroom (110) leaves near-target complete sentences intact; beyond
// that, prefer the longest run of whole sentences that fits, else trim at a
// word boundary and close with a full stop so it never looks chopped.
const TRAILING_STOPWORDS = /\s+(and|or|but|to|of|in|on|at|for|with|the|a|an|its|his|her|their|our|your|this|that|these|those|as|by|from|into|onto|over|under|about|after|before|while|amid|is|are|was|were|has|have|had|will|would|which|who|when|where)$/i;

function clampBullet(s) {
  s = String(s).replace(/\s+/g, " ").trim();
  // Complete sentences up to 118 chars pass untouched — a whole sentence
  // slightly long beats a trimmed fragment.
  if (s.length <= 118) return s;

  // Prefer the longest run of complete sentences within budget.
  const sentences = s.match(/[^.!?]+[.!?]+/g) || [];
  let acc = "";
  for (const sen of sentences) {
    if ((acc + sen).trim().length <= 116) acc += sen; else break;
  }
  acc = acc.trim();
  if (acc.length >= 40) return acc;

  // Single over-long sentence: trim at a word boundary, then drop any dangling
  // function word so it never ends on "and.", "to.", "of." etc.
  let cut = s.slice(0, 112);
  const sp = cut.lastIndexOf(" ");
  if (sp > 60) cut = cut.slice(0, sp);
  cut = cut.replace(/[\s,;:.\-–—]+$/, "").trim();
  while (TRAILING_STOPWORDS.test(cut)) cut = cut.replace(TRAILING_STOPWORDS, "").trim();
  cut = cut.replace(/[\s,;:.\-–—]+$/, "").trim();
  return cut ? cut + "." : cut;
}

// Pull readable paragraphs out of an article page for grounding.
function extractArticleText(html) {
  const articleMatch = html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i);
  const scope = articleMatch?.[1] || html;
  const paragraphs = [...scope.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
    .map((m) => cleanupText(stripTags(m[1] || "")))
    .filter((t) => t.length >= 50 && t.length <= 500)
    .filter((t) => !/^(sign up|read more|copyright|follow live|watch:|also read)/i.test(t));
  return paragraphs.slice(0, 10).join("\n");
}

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  setCors(res);

  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed." });
    return;
  }

  const apiKey = process.env.OPENAI_API_KEY || "";
  if (!apiKey) {
    res.status(503).json({ error: "OPENAI_API_KEY not set on server." });
    return;
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const headline = (body.headline || "").trim();
    const sourceUrl = (body.sourceUrl || "").trim();
    if (!headline) {
      res.status(400).json({ error: "Missing 'headline' in body." });
      return;
    }

    // Ground the model with the actual article text when we have a URL.
    let articleText = "";
    if (sourceUrl) {
      try {
        const r = await fetch(sourceUrl, { headers: { "user-agent": USER_AGENT } });
        if (r.ok) articleText = extractArticleText(await r.text());
      } catch { /* grounding is best-effort */ }
    }

    const userContent = articleText
      ? `Source headline:\n${headline}\n\nArticle text:\n${articleText}`
      : `Source headline:\n${headline}\n\n(No article text available — write from the headline only and flag that facts could not be verified against source text.)`;

    const t0 = Date.now();
    const aiRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
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
      console.error(`OpenAI ${aiRes.status}:`, errText.slice(0, 300));
      res.status(502).json({ error: `OpenAI ${aiRes.status}`, detail: errText.slice(0, 200) });
      return;
    }

    const data = await aiRes.json();
    let parsed = {};
    try { parsed = JSON.parse(data?.choices?.[0]?.message?.content || "{}"); } catch { /* below */ }

    const out = {
      headline: (parsed.headline || "").slice(0, 80),
      // Raw-normalize only (no clamp yet) so the repair pass sees full text.
      bullets: Array.isArray(parsed.bullets)
        ? parsed.bullets.slice(0, 4).map((x) => String(x).replace(/\s+/g, " ").trim())
        : [],
      tweet: clampTweet(parsed.tweet || ""),
      flags: Array.isArray(parsed.flags) ? parsed.flags.map(String) : [],
    };
    if (!out.headline || out.bullets.length < 4 || !out.tweet) {
      res.status(502).json({ error: "AI returned an incomplete package.", raw: parsed });
      return;
    }

    // If any bullet overflows or reads as a fragment, self-repair once, then
    // clamp as the final safety net (should rarely fire after repair).
    if (out.bullets.some((b) => !bulletIsValid(b))) {
      const repaired = await repairBullets(apiKey, headline, articleText, out.bullets);
      if (repaired) out.bullets = repaired;
    }
    out.bullets = out.bullets.map(clampBullet);

    console.log(`AI article (${Date.now() - t0}ms): "${out.headline}"`);
    res.status(200).json(out);
  } catch (err) {
    console.error("generate-article error:", err);
    res.status(500).json({ error: err.message || "Article generation failed." });
  }
}
