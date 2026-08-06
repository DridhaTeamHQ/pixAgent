/**
 * Editorial tone: classify, assess, rectify.
 *
 * The problem this solves: "simple" and "simplistic" are different axes, and
 * conflating them is what made the summaries read like they were written for
 * a child. Wire services write in SHORT SENTENCES with PLAIN WORDS — that is
 * simple. They also attribute every contested claim, use exact figures, and
 * never talk down — that is not simplistic. A prompt that just says "use
 * simple conversational language" collapses the two and you get baby talk.
 *
 * So instead of one fixed instruction, this module:
 *   1. CLASSIFIES the story into a register (hard news / feature / explainer)
 *   2. Emits register-specific writing rules for the generation prompt
 *   3. ASSESSES the output against measurable tone faults
 *   4. Feeds those faults back into a rectification pass
 *
 * Step 3 is deterministic and free — no model call. It only spends a repair
 * call when something is actually wrong.
 *
 * Style rules follow wire-service practice: AP guidance is explicit that
 * "said" is the neutral attribution verb and that "claimed" / "admitted" /
 * "conceded" read as loaded or judgmental.
 */

/* ── Registers ───────────────────────────────────────────────────────── */

export const REGISTERS = {
  // Courts, money, deaths, policy, disasters, crime, conflict.
  wire: {
    label: "wire",
    description: "hard news — straight, attributed, precise",
    rules: [
      "Write in the register of a wire-service report (Reuters, AP, PTI). Authoritative and neutral, never chatty.",
      "ATTRIBUTE. Any claim that is contested, forward-looking or an opinion is attributed to a named person, body or document: 'the court said', 'according to the finance ministry', 'Das said'. Uncontested facts of record do not need attribution.",
      "Use 'said' as the attribution verb. Do NOT use 'claimed', 'admitted', 'conceded', 'revealed' or 'slammed' — they read as loaded or judgmental.",
      "Active voice with strong verbs: 'The court ordered the state to pay', not 'It was ordered that payment be made'.",
      "Exact figures, dates, titles and places. Never 'a lot of', 'several', 'many', 'recently', 'huge' where a number or date exists in the source.",
      "No adjectives of judgement: shocking, stunning, massive, historic, brutal, unprecedented. Let the facts carry the weight.",
      "Third person throughout. Never address the reader as 'you'. No exclamation marks.",
    ],
  },

  // Entertainment, lifestyle, sport colour, human interest.
  feature: {
    label: "feature",
    description: "feature or infotainment — warmer, still disciplined",
    rules: [
      "Write with a lighter touch than a hard-news dispatch, but keep full factual discipline. Assured, not chatty.",
      "Attribution still applies to anything contested or opinionated, using 'said'.",
      "Colour and rhythm are welcome; hype is not. No 'shocking', 'you won't believe', no exclamation marks.",
      "Exact figures, names and dates wherever the source has them.",
      "Third person. Never address the reader as 'you'.",
    ],
  },

  // Finance, science, technology, law — where the terms matter.
  explainer: {
    label: "explainer",
    description: "technical story — precise terms, briefly glossed",
    rules: [
      "The subject is technical, so PRECISION OUTRANKS BREVITY. Use the correct term and gloss it in a short clause: 'the repo rate, the rate at which the central bank lends to banks'.",
      "Never swap a precise term for a vague one. 'Interest rate' does not become 'the cost of money'; 'inflation' does not become 'rising prices'.",
      "Attribute figures and forecasts to their source using 'said' or 'according to'.",
      "Active voice, exact numbers, no judgement adjectives, no exclamation marks.",
      "Third person. Never address the reader as 'you'.",
    ],
  },
};

export const DEFAULT_REGISTER = "wire";

/* ── 1. Classification ───────────────────────────────────────────────── */

// Deterministic pre-classification. This is a HINT passed to the model, not
// the final word — the model returns its own register choice, which wins when
// present. Keyword matching alone is too blunt to trust, but it costs nothing
// and it anchors the model when the story is unambiguous.
const HARD_NEWS_TERMS = /\b(court|supreme court|high court|judge|verdict|ruling|sentenced|convicted|arrest|police|fir|charge ?sheet|killed|dead|death|died|toll|injured|blast|fire|flood|earthquake|cyclone|crash|accident|war|strike|attack|militant|terror|budget|tax|gdp|inflation|repo rate|rbi|sebi|fraud|scam|probe|cbi|ed |raid|policy|bill|parliament|lok sabha|rajya sabha|election|minister|ordinance|ban|verdict|compensation|crore|lakh|billion|million)\b/i;

const FEATURE_TERMS = /\b(bollywood|hollywood|actor|actress|singer|album|film|movie|series|celebrity|wedding|birthday|fashion|recipe|travel|viral|meme|instagram|influencer|fan|trailer|box office|red carpet|festival|award show)\b/i;

const TECHNICAL_TERMS = /\b(repo rate|basis points|bps|yield|inflation|monetary policy|fiscal|equity|valuation|ipo|merger|acquisition|semiconductor|algorithm|ai model|vaccine|clinical trial|emissions|patent|antitrust|spectrum|api|encryption|satellite|orbit|reactor)\b/i;

function countMatches(text, re) {
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  return (text.match(g) || []).length;
}

/**
 * Suggest a register from the source material. Returns a register key.
 * Hard news wins ties — misclassifying a court story as a feature is a far
 * worse failure than the reverse.
 */
export function suggestRegister(headline = "", articleText = "") {
  const text = `${headline} ${String(articleText).slice(0, 1200)}`;
  // These patterns contain a capture group, so String.match WITHOUT /g
  // returns [fullMatch, group1] — length 2 for any hit, however many terms
  // actually matched. Counting that way made every comparison a tie and the
  // classifier always fell through to `wire`. countMatches forces the global
  // flag so the counts are real.
  const hard = countMatches(text, HARD_NEWS_TERMS);
  const feature = countMatches(text, FEATURE_TERMS);
  const technical = countMatches(text, TECHNICAL_TERMS);

  // Technical vocabulary is checked first and on its own terms, not against
  // the hard-news count. Financial and legal stories match BOTH lists (a repo
  // rate story is hard news AND technical), so comparing counts let hard news
  // always win and the reader never got the terms glossed. The explainer
  // register keeps every wire discipline and adds glossing, so preferring it
  // here costs nothing and fixes the case that reads as over-simplified.
  if (technical >= 2 || (technical === 1 && hard === 0)) return "explainer";
  if (feature > hard) return "feature";
  if (hard > 0) return "wire";
  return DEFAULT_REGISTER;
}

/** Rules block for the generation prompt. */
export function registerRules(key) {
  const reg = REGISTERS[key] || REGISTERS[DEFAULT_REGISTER];
  return [`REGISTER — ${reg.description}:`, ...reg.rules.map((r) => `- ${r}`)].join("\n");
}

/* ── 2. Assessment ───────────────────────────────────────────────────── */

// Phrases that signal writing down to the reader. These are the actual
// symptoms of the over-simplification, not a general banned-words list.
const PATRONISING = [
  [/\bbasically\b/i, "'basically'"],
  [/\bsimply put\b/i, "'simply put'"],
  [/\bin short\b/i, "'in short'"],
  [/\bin other words\b/i, "'in other words'"],
  [/\bthis means (that )?\b/i, "'this means'"],
  [/\bthink of (it|this) as\b/i, "'think of it as'"],
  [/\bwhich is a (kind|type|sort) of\b/i, "'which is a type of'"],
  [/\bkind of\b/i, "'kind of'"],
  [/\bsort of\b/i, "'sort of'"],
  [/\bstuff\b/i, "'stuff'"],
  [/\bthings like\b/i, "'things like'"],
];

// Vague quantifiers standing in for a figure.
const VAGUE_QUANTIFIERS = [
  [/\ba lot of\b/i, "'a lot of'"],
  [/\blots of\b/i, "'lots of'"],
  [/\bloads of\b/i, "'loads of'"],
  [/\btons of\b/i, "'tons of'"],
  [/\bplenty of\b/i, "'plenty of'"],
  [/\bmany many\b/i, "'many many'"],
  [/\bvery very\b/i, "'very very'"],
];

// Judgement adjectives and hype.
const EDITORIALISING = [
  [/\bshocking\b/i, "'shocking'"],
  [/\bstunning\b/i, "'stunning'"],
  [/\bmassive\b/i, "'massive'"],
  [/\bhuge\b/i, "'huge'"],
  [/\bbrutal\b/i, "'brutal'"],
  [/\bincredible\b/i, "'incredible'"],
  [/\bunbelievable\b/i, "'unbelievable'"],
  [/\bamazing\b/i, "'amazing'"],
];

// Loaded attribution verbs — AP names these explicitly as judgmental.
const LOADED_ATTRIBUTION = [
  [/\bclaimed\b/i, "'claimed'"],
  [/\badmitted\b/i, "'admitted'"],
  [/\bconceded\b/i, "'conceded'"],
  [/\bslammed\b/i, "'slammed'"],
  [/\bblasted\b/i, "'blasted'"],
];

const ATTRIBUTION_PRESENT = /\b(said|says|according to|told|announced|ruled|ordered|reported)\b/i;
const SECOND_PERSON = /\b(you|your|you're|yours)\b/i;

// An attribution tag in the TAIL of the sentence — the tic pattern, e.g.
// "..., researchers said." Attribution earlier in the sentence is normal.
const ATTRIBUTION_TAIL = /,\s*(?:[A-Za-z' .]+\s)?(said|noted|stated|added|reported|according to [^.]+)\.?\s*$/i;

// Words that soften a claim. One is honest reporting; two in a sentence
// means the sentence commits to nothing.
const HEDGES = /\b(may|might|could|suggests?|indicates?|appears?|seems?|potentially|possibly|reportedly|is expected to|are expected to|is likely to|are likely to)\b/i;

// Words too common to signal shared meaning between two bullets.
const STOP_WORDS = new Set(
  ("the a an and or but of in on at to for with from by as is are was were be been being that this these those " +
   "it its their his her our your they he she we i you which who whom whose what when where why how not no " +
   "has have had will would shall should can could may might must do does did done than then so such also " +
   "more most other some any each into over under after before while about against between during through")
    .split(" ")
);

/**
 * Find bullets that carry the same content. Compares sets of content words
 * (Jaccard overlap) rather than raw strings, so "studies indicate B12 may
 * help" and "findings suggest B12 could help" register as duplicates even
 * though they share few exact words in order.
 */
function findRepeatedBullets(bullets, threshold = 0.5) {
  const sets = bullets.map((b) =>
    new Set(
      String(b).toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/)
        .filter((w) => w.length > 2 && !STOP_WORDS.has(w))
    )
  );
  const pairs = [];
  for (let i = 0; i < sets.length; i++) {
    for (let k = i + 1; k < sets.length; k++) {
      const a = sets[i], b = sets[k];
      if (!a.size || !b.size) continue;
      let shared = 0;
      for (const w of a) if (b.has(w)) shared++;
      // Overlap against the SMALLER set: a short bullet fully contained in a
      // longer one is still a repeat, which plain Jaccard would understate.
      if (shared / Math.min(a.size, b.size) >= threshold) pairs.push(`${i + 1}/${k + 1}`);
    }
  }
  return pairs;
}

function scan(text, table) {
  const hits = [];
  for (const [re, label] of table) if (re.test(text)) hits.push(label);
  return hits;
}

/**
 * Assess bullets for tone faults. Pure and deterministic — no model call.
 *
 * `sourceHasFigures` lets us flag the specific failure of dropping numbers
 * that the source actually contained, which is the difference between
 * simplifying and losing information.
 */
export function assessTone(bullets, { register = DEFAULT_REGISTER, sourceText = "" } = {}) {
  const joined = bullets.join(" ");
  const issues = [];

  const patronising = scan(joined, PATRONISING);
  if (patronising.length) {
    issues.push(`Talks down to the reader: ${patronising.join(", ")}. Remove the hand-holding and state the fact directly.`);
  }

  const vague = scan(joined, VAGUE_QUANTIFIERS);
  if (vague.length) {
    issues.push(`Vague quantifiers where a figure belongs: ${vague.join(", ")}. Use the exact number from the source.`);
  }

  const editorial = scan(joined, EDITORIALISING);
  if (editorial.length) {
    issues.push(`Judgement adjectives: ${editorial.join(", ")}. Report the fact and let it carry its own weight.`);
  }

  const loaded = scan(joined, LOADED_ATTRIBUTION);
  if (loaded.length) {
    issues.push(`Loaded attribution verbs: ${loaded.join(", ")}. Use 'said'.`);
  }

  if (SECOND_PERSON.test(joined)) {
    issues.push("Addresses the reader as 'you'. News copy stays in the third person.");
  }

  if (/!/.test(joined)) {
    issues.push("Contains an exclamation mark. Remove it.");
  }

  /* ── Emptiness checks ──
     Fixing the register exposed a second failure: copy that SOUNDS
     professional while carrying almost no information. Four bullets restate
     one fact behind different hedges, each capped with an attribution tag,
     and the character count is met entirely with filler. These three checks
     catch that, and they are the difference between a summary and padding. */

  // 1. Repetition. Each bullet must carry a fact the others do not. Compared
  //    on content words only, so shared names and jargon don't mask it.
  const dupes = findRepeatedBullets(bullets);
  if (dupes.length) {
    issues.push(`Bullets ${dupes.join(" and ")} repeat the same fact in different words. Every bullet must add information the others do not — a new figure, name, date, cause or consequence from the source.`);
  }

  // 2. Attribution as a tic. Wire copy attributes where a claim needs a
  //    source, not on every line. Four tags on four bullets reads as a
  //    template, not as reporting.
  const tagged = bullets.filter((b) => ATTRIBUTION_TAIL.test(b)).length;
  if (bullets.length >= 3 && tagged >= bullets.length - 1) {
    issues.push(`${tagged} of ${bullets.length} bullets end with an attribution tag ('researchers said', 'according to the study'). Attribute where a claim genuinely needs a source — usually one or two bullets — and state the rest as fact.`);
  }

  // 3. Hedge stacking. "indicate that ... may improve" hedges twice and
  //    commits to nothing. One hedge is honest; two is evasion.
  const hedged = bullets.filter((b) => countMatches(b, HEDGES) >= 2).length;
  if (hedged >= 2) {
    issues.push(`${hedged} bullets stack two or more hedges ('suggests that ... could ...'). Use at most one hedge per sentence and state what was actually found.`);
  }

  // Attribution: at least one bullet in a hard-news package should carry it.
  if (register === "wire" && !ATTRIBUTION_PRESENT.test(joined)) {
    issues.push("No attribution anywhere. At least one bullet must say who said or ordered this ('the court said', 'according to the ministry').");
  }

  // Numbers present in the source but dropped from the summary.
  const sourceFigures = String(sourceText).match(/\b\d[\d,.]*\s?(crore|lakh|billion|million|percent|%)\b/gi) || [];
  const bulletHasFigure = /\d/.test(joined);
  if (sourceFigures.length > 0 && !bulletHasFigure) {
    issues.push(`The source carries figures (${sourceFigures.slice(0, 3).join(", ")}) but the bullets contain none. Include the ones that matter.`);
  }

  // Very short average word length is a decent proxy for baby talk, but it is
  // noisy on its own, so it only counts alongside another symptom.
  const words = joined.split(/\s+/).filter(Boolean);
  const avgWordLen = words.length ? words.join("").length / words.length : 0;
  if (avgWordLen < 4.1 && issues.length > 0) {
    issues.push("Vocabulary is unusually plain throughout. Use the precise word rather than the shortest one.");
  }

  return { ok: issues.length === 0, issues, register, avgWordLen: Number(avgWordLen.toFixed(2)) };
}

/* ── 3. Rectification prompt ─────────────────────────────────────────── */

/**
 * Build the instruction for a rectification pass. Naming the specific faults
 * found beats a generic "make it more professional" — the model gets told
 * exactly what to change and nothing else drifts.
 */
export function rectifyInstruction({ issues, register, min, max, count, minWords, maxWords }) {
  const reg = REGISTERS[register] || REGISTERS[DEFAULT_REGISTER];
  return [
    `Rewrite these ${count} news bullet points in the register of a professional news agency (${reg.description}).`,
    "",
    "Faults found in the current version:",
    ...issues.map((i) => `- ${i}`),
    "",
    "Register rules:",
    ...reg.rules.map((r) => `- ${r}`),
    "",
    `Each rewritten bullet is ONE complete sentence ending in a full stop, ${minWords} to ${maxWords} words long (${min}-${max} characters). Count the WORDS — character counts are hard to judge, word counts are not.`,
    "If a bullet is too short, develop it with more detail that is already in the source article. Do not pad with filler, and do not invent anything.",
    "If a bullet is too long, cut the least important clause rather than truncating the sentence.",
    "Keep the same facts, the same order and the same meaning. Add no new facts. Do not let any sentence trail off.",
    "Keep the language plain and the sentences short — plain is not the same as simplistic. Short sentences and precise words, never baby talk and never padding.",
    `Return STRICT JSON: { "bullets": [${count} strings] }.`,
  ].join("\n");
}
