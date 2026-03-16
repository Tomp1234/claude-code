# Chrome Agent — Raw Post JSON Schema

This document defines the exact JSON format that the Claude in Chrome agent must write to `docs/data/raw_posts.json` after each LinkedIn scraping run.

## File location

```
docs/data/raw_posts.json
```

The Chrome agent must **overwrite** this file completely on each run (not append).

## Format

The file must be a **JSON array** of post objects:

```json
[
  { ... post 1 ... },
  { ... post 2 ... }
]
```

## Post object schema

Every field is required. Use empty string `""` or `0` or `false` if data is unavailable.

```json
{
  "post_id": "string — unique identifier (LinkedIn URN or URL slug)",
  "source_type": "feed | hashtag | competitor",
  "source_name": "string — 'feed' for feed posts, '#powerbi' for hashtag posts, 'ThoughtSpot' for competitor posts",
  "author_name": "string — full name as displayed on LinkedIn",
  "author_title": "string — job title/headline as displayed",
  "author_company": "string — company name if visible",
  "post_text": "string — full post text content",
  "post_url": "string — direct LinkedIn URL to the post",
  "timestamp": "string — as shown on LinkedIn, e.g. '2h ago', '45m ago', '1d ago', or ISO date",
  "reaction_count": 0,
  "comment_count": 0,
  "is_suggested": false,
  "icp_commenters": []
}
```

## Field details

### `source_type`
One of three values:
- `"feed"` — from Tom's LinkedIn feed scroll (both followed and suggested posts)
- `"hashtag"` — from hashtag search results
- `"competitor"` — from competitor company pages or founder profiles

### `source_name`
- Feed posts: `"feed"`
- Hashtag posts: the hashtag including `#`, e.g. `"#powerbi"`
- Competitor posts: the competitor name, e.g. `"ThoughtSpot"`, `"Zenlytic"`, `"WisdomAI"`

### `is_suggested`
- `true` if LinkedIn labels the post as "Suggested" or "Recommended" (not from a followed account)
- `false` for posts from followed accounts, hashtag results, or competitor pages

### `icp_commenters`
Array of objects for **visible commenters on competitor posts**. Empty array `[]` for feed/hashtag posts unless commenter info is visible.

```json
{
  "name": "string — commenter's full name",
  "title": "string — commenter's job title if visible",
  "company": "string — commenter's company if visible"
}
```

## Sources to scrape per run

### 1. Feed (100 posts)
Scroll Tom's LinkedIn feed and extract 100 posts. Include both followed and suggested/recommended posts.

### 2. Hashtags (top 10 per hashtag)
Search each hashtag and extract the 10 most recent posts:
- `#businessintelligence`
- `#selfservicebi`
- `#dataanalytics`
- `#aisecurity`
- `#chatgpt`
- `#microsoftcopilot`
- `#powerbi`
- `#operationalexcellence`

(These may change — check `docs/data/config.json` for the current list)

### 3. Competitor pages
Visit each page and extract all visible posts from the last 24 hours. Also extract visible commenters with name/title/company.

Competitor list is in `docs/data/config.json`. Default:
- ThoughtSpot — company page
- Zenlytic — company page + founder profile
- WisdomAI — company page + founder profile

## Run schedule
Twice daily on weekdays: 7:30am and 1:00pm GMT.

## After scraping
1. Write the JSON array to `docs/data/raw_posts.json`
2. `git add docs/data/raw_posts.json`
3. `git commit -m "Raw posts — YYYY-MM-DD HH:MM"`
4. `git push`

The GitHub Actions workflow runs 5 minutes later to score the posts.

## Hard rules
- NEVER like, comment, react, connect, follow, or take any action on LinkedIn
- Scroll at human pace
- On CAPTCHA or verification: stop immediately, do not retry
- On any unexpected modal/prompt: close it and continue, or abort and log
