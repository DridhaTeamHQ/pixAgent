// AI article writer — gpt-4o-mini, JSON mode.
// Takes { headline, sourceUrl? } and returns:
//   { headline, bullets: [3 strings], tweet, flags: [notes] }
// following the Shortly editorial format & safety rules.

import { USER_AGENT, setCors, handlePreflight } from "../lib/http.js";
import { stripTags, cleanupText } from "../lib/scrape.js";

export const EDITORIAL_SYSTEM_PROMPT = [
  "You are a news sub-editor at Shortly. Given a source headline (and article text when available), produce a news package in STRICT JSON with this exact shape:",
  "",
  '{ "headline": string, "bullets": [string, string, string], "tweet": string, "flags": [string] }',
  "",
  "FORMAT RULES:",
  "1. headline: max 60 characters. Newspaper style. Correct sentence capitalisation (capitalise first word and proper nouns only). No repeated phrases from the bullets. No periods in initials (write PM, US, UK — never P.M., U.S.).",
  "2. bullets: exactly 3 bullet points covering the most important parts of the news. Each bullet should be about TWO lines of text — 20 to 32 words with real substance: what happened plus who/where/the key figure or consequence. Not a one-line fragment, not a paragraph. Do not repeat the headline's phrasing.",
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
      bullets: Array.isArray(parsed.bullets) ? parsed.bullets.slice(0, 3).map(String) : [],
      tweet: (parsed.tweet || "").slice(0, 280),
      flags: Array.isArray(parsed.flags) ? parsed.flags.map(String) : [],
    };
    if (!out.headline || out.bullets.length < 3 || !out.tweet) {
      res.status(502).json({ error: "AI returned an incomplete package.", raw: parsed });
      return;
    }

    console.log(`AI article (${Date.now() - t0}ms): "${out.headline}"`);
    res.status(200).json(out);
  } catch (err) {
    console.error("generate-article error:", err);
    res.status(500).json({ error: err.message || "Article generation failed." });
  }
}
