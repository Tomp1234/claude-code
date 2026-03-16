const Anthropic = require("@anthropic-ai/sdk");
const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "docs", "data");
const RAW_PATH = path.join(DATA_DIR, "raw_posts.json");
const SCORED_PATH = path.join(DATA_DIR, "scored_posts.json");
const LOG_PATH = path.join(DATA_DIR, "log.json");
const CONFIG_PATH = path.join(DATA_DIR, "config.json");

const MODEL = "claude-sonnet-4-6";

const ICP_TITLES = [
  "coo",
  "chief operating officer",
  "vp operations",
  "vice president operations",
  "director of operations",
  "head of innovation",
  "innovation director",
  "vp innovation",
  "vice president innovation",
  "commercial director",
  "ceo",
];

const AUTO_DROP_AUTHOR_TITLES = [
  "ai",
  "data",
  "bi",
  "analytics",
  "insights",
  "engineering",
  "cto",
];

function parseLinkedInTimestamp(timestampStr) {
  if (!timestampStr) return null;
  const now = new Date();
  const str = timestampStr.toLowerCase().trim();

  const match = str.match(/(\d+)\s*(m|min|minute|h|hr|hour|d|day|w|week|mo|month)s?\s*ago/);
  if (match) {
    const num = parseInt(match[1]);
    const unit = match[2];
    const ms = now.getTime();
    if (unit.startsWith("m") && !unit.startsWith("mo")) return new Date(ms - num * 60 * 1000);
    if (unit.startsWith("h")) return new Date(ms - num * 3600 * 1000);
    if (unit.startsWith("d")) return new Date(ms - num * 86400 * 1000);
    if (unit.startsWith("w")) return new Date(ms - num * 7 * 86400 * 1000);
    if (unit.startsWith("mo")) return new Date(ms - num * 30 * 86400 * 1000);
  }

  // Try ISO date
  const parsed = new Date(timestampStr);
  if (!isNaN(parsed.getTime())) return parsed;

  return null;
}

function getPostAgeHours(timestampStr) {
  const postDate = parseLinkedInTimestamp(timestampStr);
  if (!postDate) return null;
  return (Date.now() - postDate.getTime()) / (1000 * 3600);
}

function isAuthorAutoDropped(authorTitle) {
  if (!authorTitle) return false;
  const lower = authorTitle.toLowerCase();
  return AUTO_DROP_AUTHOR_TITLES.some((keyword) => {
    const regex = new RegExp(`\\b${keyword}\\b`, "i");
    return regex.test(lower);
  });
}

function countICPEngagement(icpCommenters) {
  if (!icpCommenters || !Array.isArray(icpCommenters)) return 0;
  let count = 0;
  for (const commenter of icpCommenters) {
    const title = (commenter.title || "").toLowerCase();
    const isICP = ICP_TITLES.some((icpTitle) => title.includes(icpTitle));
    if (isICP) count++;
  }
  return Math.min(count, 3);
}

function isPurelyPromotional(postText) {
  if (!postText) return false;
  const promoSignals = [
    /\bregister now\b/i,
    /\bsign up\b/i,
    /\bjoin us\b/i,
    /\buse code\b/i,
    /\bdiscount\b/i,
    /\bfree trial\b/i,
    /\bcheck out our\b/i,
    /\bwe're hiring\b/i,
    /\bapply now\b/i,
    /\blink in bio\b/i,
    /\bbook a demo\b/i,
    /\blearn more at\b/i,
  ];
  const matchCount = promoSignals.filter((r) => r.test(postText)).length;
  return matchCount >= 2;
}

function preFilter(posts, loggedUrls) {
  return posts.filter((post) => {
    // Drop if already in log
    if (loggedUrls.has(post.post_url)) return false;

    // Drop if over 24 hours old
    const ageHours = getPostAgeHours(post.timestamp);
    if (ageHours !== null && ageHours > 24) return false;

    // Drop if author title is auto-drop
    if (isAuthorAutoDropped(post.author_title)) return false;

    // Drop if purely promotional with zero ICP engagement
    if (isPurelyPromotional(post.post_text) && countICPEngagement(post.icp_commenters) === 0)
      return false;

    return true;
  });
}

function calculateRecencyScore(timestampStr) {
  const ageHours = getPostAgeHours(timestampStr);
  if (ageHours === null) return 1; // default middle score if unknown
  if (ageHours <= 6) return 2;
  if (ageHours <= 12) return 1;
  if (ageHours <= 24) return 0.5;
  return 0; // should already be filtered out
}

function calculateReachBonus(post) {
  if (post.is_suggested && (post.reaction_count || 0) >= 50) return 1;
  return 0;
}

async function scoreAndDraft(client, posts, config) {
  const threshold = config.score_threshold || 6;
  const results = [];

  // Process in batches of 5
  for (let i = 0; i < posts.length; i += 5) {
    const batch = posts.slice(i, i + 5);
    const promises = batch.map((post) => scorePost(client, post, threshold));
    const batchResults = await Promise.all(promises);
    results.push(...batchResults.filter(Boolean));
  }

  return results;
}

async function scorePost(client, post, threshold) {
  const icpCount = countICPEngagement(post.icp_commenters);
  const recencyScore = calculateRecencyScore(post.timestamp);
  const reachBonus = calculateReachBonus(post);

  // Pre-calculated scores
  const knownScores = {
    icp_engagement: icpCount,
    recency: recencyScore,
    reach_bonus: reachBonus,
  };

  const scoringPrompt = `You are scoring a LinkedIn post for comment-worthiness. Score ONLY the following two factors — the other scores are pre-calculated.

POST:
Author: ${post.author_name} (${post.author_title || "no title"} at ${post.author_company || "unknown"})
Source: ${post.source_type} (${post.source_name})
Text: ${post.post_text}
Reactions: ${post.reaction_count || 0}
Comments: ${post.comment_count || 0}
ICP commenters found: ${icpCount}

SCORE THESE TWO FACTORS:

1. Topic fit (0-3):
   - 3: Power BI adoption failures, self-service BI criticism, AI trust gap/hallucinations
   - 2: Copilot failures, shadow AI, build vs buy
   - 1: General BI/data content
   - 0: Off-topic

2. Comment value (0-2):
   - Does a comment from Tom (a BI/analytics founder) add genuine insight or look like noise?
   - Posts inviting debate, expressing frustration, or asking a question score higher
   - Pure promotional posts score 0 unless ICP titles are engaging
   - 2 = strong opportunity for authentic insight, 1 = decent, 0 = noise

Respond ONLY with valid JSON, no other text:
{"topic_fit": <0-3>, "comment_value": <0-2>}`;

  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 100,
      messages: [{ role: "user", content: scoringPrompt }],
    });

    const text = response.content[0].text.trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error(`Failed to parse scoring response for post: ${post.post_id}`);
      return null;
    }

    const scores = JSON.parse(jsonMatch[0]);
    const totalScore =
      scores.topic_fit +
      knownScores.icp_engagement +
      knownScores.recency +
      scores.comment_value +
      knownScores.reach_bonus;

    const roundedScore = Math.round(totalScore * 10) / 10;

    if (roundedScore < threshold) return null;

    // Draft comment for posts meeting threshold
    const draft = await draftComment(client, post, scores, roundedScore);

    return {
      ...post,
      score: roundedScore,
      score_breakdown: {
        topic_fit: scores.topic_fit,
        icp_engagement: knownScores.icp_engagement,
        recency: knownScores.recency,
        comment_value: scores.comment_value,
        reach_bonus: knownScores.reach_bonus,
      },
      angle: draft.angle,
      draft_comment: draft.comment,
      scored_at: new Date().toISOString(),
    };
  } catch (err) {
    console.error(`Error scoring post ${post.post_id}:`, err.message);
    return null;
  }
}

async function draftComment(client, post, scores, totalScore) {
  const icpNames =
    (post.icp_commenters || [])
      .filter((c) => {
        const title = (c.title || "").toLowerCase();
        return ICP_TITLES.some((t) => title.includes(t));
      })
      .map((c) => `${c.name} (${c.title} at ${c.company})`)
      .join(", ") || "none";

  const prompt = `You are drafting a LinkedIn comment for Tom, founder of Milo (a BI/analytics product).

POST CONTEXT:
Author: ${post.author_name} (${post.author_title || ""} at ${post.author_company || ""})
Source: ${post.source_type} (${post.source_name})
Post text: ${post.post_text}
Score: ${totalScore}/10
Topic fit: ${scores.topic_fit}/3
ICP prospects engaging: ${icpNames}

Produce TWO things:

1. ANGLE (one sentence): Why Tom should comment and what position to take. Examples:
   - "ICP prospect (COO at 150-person agency) frustrated with Power BI — validate the pain, don't pitch"
   - "ThoughtSpot pushing enterprise framing — challenge with mid-market reality"
   - "Self-service BI criticism thread with Innovation Director engaging — add the 'tools that explain not just show' insight"

2. DRAFT COMMENT: Written in Tom's voice. HARD RULES:
   - 2-4 sentences max
   - Sounds like Tom talking, not writing. Slightly unfinished is fine.
   - Lead with a specific observation, not generic agreement
   - End with a question or quiet gut-punch line — never a CTA
   - NEVER start with "Great post" or any variation
   - NEVER use: leverage, synergy, transformative, game-changing, actionable insights
   - Mention Milo ONLY if it fits completely naturally — if in doubt, leave it out
   - For competitor posts: challenge with curiosity not aggression
   - For ICP prospect engagement: validate their pain first, add insight second, never pitch

Tom's voice example: "I reckon this is the same pattern every time. The building part is easy. Getting your CFO to trust it enough to quote numbers in a board meeting? That takes years not sprints."

Respond ONLY with valid JSON:
{"angle": "<one sentence>", "comment": "<2-4 sentence draft>"}`;

  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 300,
      messages: [{ role: "user", content: prompt }],
    });

    const text = response.content[0].text.trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
  } catch (err) {
    console.error(`Error drafting comment for ${post.post_id}:`, err.message);
  }

  return { angle: "Review this post manually", comment: "" };
}

async function main() {
  console.log("LinkedIn Comment Scoring Pipeline");
  console.log("=================================");

  // Load data files
  let rawPosts, log, config;
  try {
    rawPosts = JSON.parse(fs.readFileSync(RAW_PATH, "utf-8"));
    log = JSON.parse(fs.readFileSync(LOG_PATH, "utf-8"));
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
  } catch (err) {
    console.error("Error reading data files:", err.message);
    process.exit(1);
  }

  if (!Array.isArray(rawPosts) || rawPosts.length === 0) {
    console.log("No raw posts to process. Writing empty scored output.");
    const output = { last_run: new Date().toISOString(), posts: [] };
    fs.writeFileSync(SCORED_PATH, JSON.stringify(output, null, 2));
    return;
  }

  console.log(`Raw posts: ${rawPosts.length}`);

  // Build set of already-logged URLs
  const loggedUrls = new Set(log.map((entry) => entry.post_url));

  // Pre-filter
  const filtered = preFilter(rawPosts, loggedUrls);
  console.log(`After pre-filter: ${filtered.length} (dropped ${rawPosts.length - filtered.length})`);

  if (filtered.length === 0) {
    console.log("No posts passed pre-filtering. Writing empty scored output.");
    const output = { last_run: new Date().toISOString(), posts: [] };
    fs.writeFileSync(SCORED_PATH, JSON.stringify(output, null, 2));
    return;
  }

  // Initialize Claude client
  const client = new Anthropic();

  // Score and draft
  console.log("Scoring posts via Claude API...");
  const scoredPosts = await scoreAndDraft(client, filtered, config);
  console.log(`Posts meeting threshold: ${scoredPosts.length}`);

  // Sort by score descending
  scoredPosts.sort((a, b) => b.score - a.score);

  // Write output
  const output = {
    last_run: new Date().toISOString(),
    posts: scoredPosts,
  };

  fs.writeFileSync(SCORED_PATH, JSON.stringify(output, null, 2));
  console.log(`Scored output written to ${SCORED_PATH}`);
  console.log("Done.");
}

main().catch((err) => {
  console.error("Pipeline failed:", err);
  process.exit(1);
});
