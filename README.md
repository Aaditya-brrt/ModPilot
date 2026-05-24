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

1. **Agent loop** — `runAgent()` keeps a Gemini 2.5 Flash chat session with up
   to 8 tool-calling turns. The model sees 26 tools as JSON-schema function
   declarations and decides which to call.
2. **Tools** — `read` (search_posts, get_post, get_user, get_modqueue,
   get_modmail_conversations, get_mod_notes, list_flagged_reposts, …),
   `analyze` (check_post_for_repost, describe_image), `mutate` (remove_post,
   ban_user, reply_as_mod, send_modmail, add_mod_note, …). Every mutation
   tool requires a `confirmation: string` describing exactly what action it
   will take, forcing the model to ground itself in fields it just read.
3. **Repost detection** — `onPostCreate` fingerprints every new post (title +
   body + a Gemini Vision description of any linked image), embeds it via
   `gemini-embedding-2` (768-dim), and stores it in Redis. The pipeline
   compares each new post against the rolling window; matches above threshold
   are auto-commented and reported. The agent surfaces those flags through
   `list_flagged_reposts` and `check_post_for_repost`.
4. **Streaming UI** — the chat view polls `/api/chat/:id/events` every 250ms
   with a single-flight lock. Events include `user_message`, `tool_call`,
   `tool_result`, `text_chunk`, `assistant_done`, `error` — rendered as
   bubbles, expandable tool cards, and a typed-out final response.
5. **Mop** — the template's bulk-comment-removal tool is still wired up under
   subreddit menu items.

## Features

- **Natural-language moderation** — describe outcomes, not API calls.
- **Read-before-write** — the system prompt + per-tool schemas force the
  model to fetch a target before mutating it.
- **Parallel reads** — independent reads in a turn run concurrently.
- **Repost detection (built-in tool)** — multimodal (text + image), with
  whitelist learning when mods mark a pair as not-a-repost.
- **Image vision** — Gemini Vision describes post images; descriptions are
  cached in the fingerprint and surfaced to the agent automatically.
- **Mod notes** — read and write mod-notes per user via tools.
- **Modmail** — list, read, reply, and send.
- **Daily cleanup** — old fingerprints pruned automatically.
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
| Mop comments | comment | mods |
| Mop post comments | post | mods |

## Architecture

```
src/
  index.ts            Hono bootstrap, route mounting
  core/
    nuke.ts           Original Mop bulk-comment logic
    gemini.ts         Gemini embedding + vision wrappers
    fingerprint.ts    Redis fingerprint + flag + whitelist store
    similarity.ts     Cosine sim + base64 vector encoding
    repost.ts         Repost-detection pipeline: index → match → flag
    modpilot/
      agent.ts        Agent loop (max 8 turns), event streaming
      llm.ts          Gemini chat + function-calling wrapper
      prompt.ts       System prompt
      session.ts      Redis session + event store
      tools.ts        Tool registry (read / analyze / mutate)
  routes/
    api.ts            Web-view backend (health)
    chat.ts           Chat endpoints
    forms.ts          Form submit handlers
    menu.ts           Menu actions
    triggers.ts       PostCreate / PostDelete / AppInstall
    jobs.ts           Scheduled cleanup
  client/
    chat.html         Chat UI shell
    chat.css          Dark-theme styles
    chat.js           Chat logic, single-flight polling
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
   - "Show me everything in the modqueue right now."
   - "Find new accounts that posted today and look like spam."
   - "Audit u/<seeder>'s last 50 actions. Anything off?"
   - "Show me reposts flagged in the last 24h."
4. Approve a mutation and watch the tool-call card go from pending → green
   with a summary.

## Status

Hackathon submission target: **May 27 2026, 6pm PDT**.
