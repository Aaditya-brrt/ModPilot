# ModPilot

A natural-language moderation copilot for Reddit, built on Devvit.



ModPilot embeds a chat-style agent inside your subreddit. Mods describe what
they want done in plain English ("show me reposts flagged in the last 24h",
"audit u/foo's last 50 actions", "ban the user behind the spam wave and lock
the post") and the agent reads subreddit state, plans, and acts — with
mandatory confirmation sentences on every mutation, Cursor-style.

Built for the [Reddit Mod Tools & Migrated Apps Hackathon](https://mod-tools-migration.devpost.com/)
(May 27 2026 deadline).

## Why this exists

Existing mod bots are rule-based and one-shot: install a config, edit YAML,
maybe write a regex. Real mod work is messy, multi-step, and contextual —
"find new accounts that posted today AND are getting reported, show me their
post histories, and ban the obvious spammers". ModPilot turns that workflow
into a single chat turn: the agent picks the right tools, runs reads in
parallel, summarizes, and only mutates after you approve.

## How it works

1. **Agent loop** — `runAgent()` runs a Gemini 2.5 Flash chat session that calls
   tools until the request is done. There's no fixed turn limit (a high
   circuit-breaker guards against runaway loops); a **stop button** interrupts a
   run at any time. The model sees 29 tools as JSON-schema function declarations
   and decides which to call. It writes one brief lead-in before its first
   action, then acts without narration and ends with a single summary. Long
   chats are compacted before each request — recent messages kept whole, older
   tool payloads stubbed.
2. **Tools** — `read` (search_posts, get_post, get_user, get_modqueue,
   get_modmail, get_mod_notes, get_subreddit_rules, get_automod_config, …),
   `analyze` (check_post_for_repost, scan_rule_violations, describe_image),
   `mutate` (remove_post, ban_user, reply_as_mod, send_modmail, add_mod_note,
   create_subreddit_rule, update_automod_config, …). Every
   mutation requires a `confirmation: string` describing exactly what it will do
   (grounding the model in fields it just read) and is blocked up front if the
   target isn't in the current subreddit. In manual mode each mutation is gated
   by an approval UI; in auto mode they run unattended.
3. **Repost detection** — `onPostCreate` fingerprints every new post into Redis:
   title + body as one vector, a Gemini Vision description of any image as a
   second, independent vector (both `gemini-embedding-2`, 768-dim). Each new
   post is matched against the rolling window; matches above threshold are
   auto-commented and **reported into the modqueue** with a reason like
   `ModPilot repost 87% match with t3_…`. The agent finds them via
   `get_modqueue`, or tests one post on demand with `check_post_for_repost`. A
   periodic sweep retries failed embeds, re-scans recent posts, and prunes stale
   flags.
4. **Rule-violation scanning** — `scan_rule_violations` pulls the subreddit's
   actual rules and batch-judges recent posts (or the modqueue) against all of
   them in one model pass, returning only clear violations with the cited rule,
   a confidence score, and a short reason. It never mutates — the agent reviews
   the results and acts under the approval gate.
5. **AutoModerator integration** — the agent reads the subreddit's AutoMod
   config (the `config/automoderator` wiki page) to explain or audit existing
   rules, and writes it under the approval gate: append one YAML rule or replace
   the whole page. Because Reddit validates the config server-side and rejects
   bad YAML as an opaque HTTP 415, every proposed rule is first checked against
   the **exact AutoMod schema** (ported from Reddit's own engine) — invalid
   modifiers/actions are caught with a precise fix *before* the write, and the
   agent self-corrects in-loop.
6. **Web-view UI** — a dark, Cursor-style chat. Tool calls render inline and
   chronologically as expandable cards; the final reply types out via a
   client-side animation. The view polls `/api/chat/:id/events` every 250ms
   (single-flight). Switching chats shows a loading skeleton, and an in-memory
   per-session event cache makes revisits instant. The whole view is
   **moderators-only** — non-mods get a block screen, and every endpoint
   enforces it server-side.
7. **Mop** — the template's bulk-comment-removal tool is still wired up under
   subreddit menu items.

## Features

- **Natural-language moderation** — describe outcomes, not API calls.
- **Read-before-write** — the system prompt + per-tool schemas force the model
  to fetch a target before mutating it; out-of-subreddit targets are rejected
  up front with a clear message instead of a cryptic API error.
- **Parallel reads** — independent reads in a turn run concurrently.
- **Manual or auto approval** — gate every mutation, or run unattended; stop a
  run at any time with the stop button.
- **Repost detection** — multimodal (independent text + image vectors), flagged
  into the modqueue, with whitelist learning when mods mark a pair not-a-repost.
- **Rule-violation scanning** — batched LLM classification of posts against your
  real subreddit rules, returning the cited rule + confidence + reason.
- **AutoModerator integration** — read, explain, and write the subreddit's
  AutoMod config in natural language; proposed rules are validated against the
  exact AutoMod schema before saving, so invalid YAML is caught with a precise
  fix instead of Reddit's silent rejection.
- **Image vision** — Gemini Vision describes post images; cached in the
  fingerprint and reused by detection, scanning, and the agent.
- **Mod notes & modmail** — read and write both via tools.
- **Maintenance** — daily fingerprint cleanup, a periodic resweep, and a manual
  "Clean up repost data" menu action that reconciles stale flags.
- **Moderators-only** — the chat is gated to mods, enforced server-side.
- **Tunable** — repost threshold, lookback window, auto-comment, and
  auto-report are per-subreddit settings.

## Setup

1. `npm install`
2. Get a free Gemini API key from <https://aistudio.google.com/apikey>
3. `npm run dev` — uploads to your playtest subreddit defined in
   `devvit.json#dev.subreddit`
4. Open the app's settings page in the subreddit and paste the Gemini key into
   the **global** `geminiApiKey` field.
5. From the subreddit menu (mod-only) → **Seed test posts (dev only)** to
   populate the dev subreddit with a variety of policy violations for the
   agent to act on.
6. From the subreddit menu → **Open ModPilot** to launch the chat.

## Settings (per subreddit)

| Setting | Default | What it does |
|---|---|---|
| `similarityThreshold` | 85 | Posts above this % similarity get flagged as reposts |
| `autoCommentEnabled` | true | Bot replies under flagged posts with original link |
| `autoReportEnabled` | true | Flagged posts also get reported into modqueue |
| `lookbackDays` | 90 | Repost comparison window; older fingerprints pruned daily |

## Menu items

| Label | Where | Who |
|---|---|---|
| Open ModPilot | subreddit | mods |
| Check this post for reposts | post | mods |
| Seed test posts (dev only) | subreddit | mods |
| Clean up repost data | subreddit | mods |
| Mop comments | comment | mods |
| Mop post comments | post | mods |

## Architecture

```
src/
  index.ts            Hono bootstrap, route mounting
  core/
    nuke.ts           Original Mop bulk-comment logic
    gemini.ts         Gemini wrappers: embed, vision, rule classification
    fingerprint.ts    Redis fingerprint + flag + whitelist store
    similarity.ts     Cosine sim + base64 vector encoding
    repost.ts         Repost pipeline: index → match → flag; sweep + cleanup
    automod/          AutoMod config: schema + YAML parser + validator
    modpilot/
      agent.ts        Agent loop (turn-ceiling + stop), event streaming;
                      guards: no-op, malformed-call, don't-quit-on-failure
      llm.ts          Gemini chat + function-calling wrapper
      prompt.ts       System prompt
      session.ts      Redis session + event + interrupt store
      tools.ts        Tool registry (read / analyze / mutate)
  routes/
    api.ts            Web-view backend (health)
    chat.ts           Chat endpoints + moderators-only gate (whoami)
    forms.ts          Form submit handlers (mop, clean-up)
    menu.ts           Menu actions
    triggers.ts       PostCreate / PostDelete / AppInstall
    jobs.ts           Scheduled cleanup + resweep
  client/
    chat.html         Chat UI shell
    chat.css          Dark-only styles
    chat.js           Chat logic: polling, typewriter, skeleton + cache
```

## Commands

```
npm run dev          # devvit playtest with hot upload
npm run build        # vite build → dist/server + dist/client
npm run type-check   # tsc --build
npm run lint         # eslint
npm run deploy       # type-check + lint + test + devvit upload
npm run launch       # deploy + devvit publish
```

## Demo plan

1. Install on a sandbox subreddit, set Gemini key.
2. Run **Seed test posts (dev only)** — populates spam, rule violations,
   reposts, modmail threads, mod notes.
3. Open ModPilot. Try:
   - "Show me everything in the modqueue right now." (reposts surface here)
   - "Scan the last 3 days for rule violations."
   - "Find new accounts that posted today and look like spam."
   - "Audit u/<seeder>'s last 50 actions. Anything off?"
4. Approve a mutation and watch the tool-call card go from pending → green
   with a summary — or flip to auto mode and use the stop button to interrupt.

## Status

Hackathon submission target: **May 27 2026, 6pm PDT**.
