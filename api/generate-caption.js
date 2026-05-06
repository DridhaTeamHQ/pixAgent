// AI tweet caption generator — gpt-4o-mini.
// Frontend calls this before opening the X intent URL.

import { setCors, handlePreflight } from "../lib/http.js";

const SYSTEM_PROMPT = [
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
  'Headline: "Modi tables Finance Bill 2026 in Parliament amid opposition uproar"',
  "Tweet: Finance Bill 2026 hits the floor — and the opposition isn't letting it pass quietly. Key clauses on capital gains and digital tax are already drawing fire. #FinanceBill2026 #Parliament #IndianPolitics",
  "",
  'Headline: "Apple unveils Vision Pro 2 with 50% lighter design at WWDC"',
  "Tweet: Apple's second swing at spatial computing is half the weight — and apparently twice the battery life. The price tag? Still TBD. #VisionPro2 #WWDC #Apple",
  "",
  'Headline: "India crowned T20 World Cup champions after 11-year drought"',
  "Tweet: 11 years. One trophy back home. India's T20 wait is over. #T20WorldCup #TeamIndia #Cricket",
].join("\n");

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
    if (!headline) {
      res.status(400).json({ error: "Missing 'headline' in body." });
      return;
    }

    const t0 = Date.now();
    const aiRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: `Headline:\n${headline}` },
        ],
        temperature: 0.8,
        max_tokens: 140,
      }),
    });

    if (!aiRes.ok) {
      const errText = await aiRes.text().catch(() => "");
      console.error(`✗ OpenAI ${aiRes.status}:`, errText.slice(0, 300));
      res.status(502).json({ error: `OpenAI ${aiRes.status}`, detail: errText.slice(0, 200) });
      return;
    }

    const data = await aiRes.json();
    let caption = data?.choices?.[0]?.message?.content?.trim() || "";
    caption = caption.replace(/^["“”']+|["“”']+$/g, "").trim();
    if (caption.length > 280) caption = caption.slice(0, 277) + "…";

    console.log(`✓ AI caption (${Date.now() - t0}ms, ${caption.length} chars)`);
    res.status(200).json({ caption });
  } catch (err) {
    console.error("✗ generate-caption error:", err);
    res.status(500).json({ error: err.message || "Caption generation failed." });
  }
}
