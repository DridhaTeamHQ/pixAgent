// AI article writer — gpt-4o-mini, JSON mode.
// Takes { headline, sourceUrl? } and returns:
//   { headline, bullets: [3 strings], tweet, flags: [notes] }
// following the Shortly editorial format & safety rules.

import { USER_AGENT, setCors, handlePreflight } from "../lib/http.js";
import { stripTags, cleanupText } from "../lib/scrape.js";

export const EDITORIAL_SYSTEM_PROMPT = [
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
  const sp = cut.lastIndexOf(" ");
  const nl = cut.lastIndexOf("\n");
  const boundary = Math.max(sp, nl);
  if (boundary > 240) cut = cut.slice(0, boundary);
  return cut.trim();
}

// A bullet is "good" when it's a complete sentence in the target band.
function bulletIsValid(b) {
  const t = String(b).trim();
  // Target 80-90; allow a little slack, but flag real overflows/fragments.
  if (t.length < 50 || t.length > 84) return false;
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
    "Rewrite these 3 news bullet points so EACH one is a single complete sentence that ends with a full stop and is between 65 and 80 characters long including spaces (never over 80). Keep the same facts and meaning; add no new facts; do not let any sentence trail off. Return STRICT JSON: { \"bullets\": [3 strings] }.\n\n" +
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
    const b = Array.isArray(parsed.bullets) ? parsed.bullets.slice(0, 3).map((x) => String(x).replace(/\s+/g, " ").trim()) : null;
    return b && b.length === 3 && b.every(Boolean) ? b : null;
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
  // Complete sentences up to 84 chars pass untouched — a whole sentence
  // slightly long beats a trimmed fragment.
  if (s.length <= 84) return s;

  // Prefer the longest run of complete sentences within budget. Mask decimal
  // points first (6.5, Rs 1.2) so they aren't mistaken for sentence ends.
  const MASK = String.fromCharCode(0xE000);
  const masked = s.replace(/(\d)\.(\d)/g, `$1${MASK}$2`);
  const sentences = masked.match(/[^.!?]+[.!?]+/g) || [];
  let acc = "";
  for (const sen of sentences) {
    if ((acc + sen).trim().length <= 82) acc += sen; else break;
  }
  acc = acc.split(MASK).join(".").trim();
  if (acc.length >= 55) return acc;   // else too short a fragment — trim instead

  // Single over-long sentence: trim at a word boundary, then drop any dangling
  // function word so it never ends on "and.", "to.", "of." etc.
  let cut = s.slice(0, 78);
  const sp = cut.lastIndexOf(" ");
  if (sp > 45) cut = cut.slice(0, sp);
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
        ? parsed.bullets.slice(0, 3).map((x) => String(x).replace(/\s+/g, " ").trim())
        : [],
      tweet: clampTweet(parsed.tweet || ""),
      flags: Array.isArray(parsed.flags) ? parsed.flags.map(String) : [],
    };
    if (!out.headline || out.bullets.length < 3 || !out.tweet) {
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
