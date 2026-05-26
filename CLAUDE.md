# CLAUDE.md

Project context for AI assistants working in this repo.

## What this is

**ModPilot** — a Devvit moderation copilot for Reddit. Mods chat with it in a
web-view ("Cursor for mod work"); the agent reads subreddit state with read
tools and takes moderation actions (remove, lock, ban, modmail, mod-notes,
etc.) with mandatory `confirmation` sentences on every mutation. Built for the
[Reddit Mod Tools & Migrated Apps Hackathon](https://mod-tools-migration.devpost.com/)
(submission deadline **May 27 2026, 6pm PDT**).

Repost detection is one capability inside ModPilot, not a separate app:
1. `onPostCreate` trigger fingerprints every new post into **two independent**
   `gemini-embedding-2` vectors (768-dim via `outputDimensionality`): one for
   title+body, one for the Gemini Vision image description (image vector absent
   on text-only posts). Failed embeds are queued for retry.
2. Matches each new post against recent posts in Redis (sliding window) using
   `combined = max(textSim, imageSim)`.
3. If ≥ threshold, flags the post: stores flag in Redis, posts an auto-comment
   linking the original, and **reports it to the modqueue** with reason
   `ModPilot repost <pct>% match with <t3_id>`.
4. The agent finds reposts via **`get_modqueue`** (reading the report reason) —
   there is no longer a separate list tool — and tests a single post on demand
   with `check_post_for_repost`.

**Rule-violation scanning** (`scan_rule_violations`) is the other AI capability:
it pulls the subreddit's real rules and batch-judges recent posts (or the
modqueue) against all of them in one Gemini call (`classifyPostsAgainstRules`
in `gemini.ts`, JSON response mode), returning clear violations with cited rule
+ confidence + reason. It is read-only; the agent acts on results via the
mutation tools under the approval gate.

**AutoModerator integration** is the third capability. The agent can read the
subreddit's AutoMod config (`get_automod_config` → `reddit.getWikiPage` on the
`config/automoderator` wiki page) to explain or audit existing rules, and write
it (`update_automod_config` → `reddit.updateWikiPage`, gated like any mutation):
`rule` appends one YAML block, `content` replaces the whole page. Reddit
validates the config server-side and rejects invalid YAML as an opaque HTTP 415,
so every write is first checked locally against the exact AutoMod schema (ported
from `reddit-archive/reddit` `r2/r2/lib/automoderator.py`) in `src/core/automod/`
— invalid modifiers/actions are blocked with a precise message before the write,
and the agent self-corrects within the loop. The app's `moderator` reddit scope
already covers wiki read/write; no extra grant is needed.

The original template's "Mop" bulk-comment tool is left intact as a secondary
utility.

## Stack

- **Devvit Web** (`@devvit/web@0.12.23`) — server runs as Hono on Node 22,
  packaged via Vite into `dist/server/index.cjs`.
- **Hono 4.11** — HTTP server framework. Routes live under `src/routes/`,
  internal endpoints under `/internal/...`, public web-view endpoints under
  `/api/...`.
- **Vite 7** — bundles both server (entry `src/index.ts`) and web-view client
  (entry `src/client/chat.html`).
- **TypeScript 5.9** — strict mode, `noUncheckedIndexedAccess: true`. ESM
  modules.
- **Gemini** (`generativelanguage.googleapis.com`) — `gemini-2.5-flash` for
  chat + function calling **and** rule-violation classification (JSON response
  mode), `gemini-embedding-2` (768-dim via `outputDimensionality`) for repost
  embeddings, and `gemini-2.5-flash` vision for image descriptions. API key
  stored as Devvit secret setting
  `geminiApiKey`. Embedding spaces between `gemini-embedding-2` and the older
  `text-embedding-004` / `gemini-embedding-001` are **incompatible** — any
  old fingerprints in Redis must be cleared on model change.
  
## Devvit primitives in use

| Primitive | Where | Why |
|---|---|---|
| `reddit` client | `@devvit/web/server` | Read posts, submit comments, report, ban, approve, modmail, mod-notes, read/write wiki (AutoMod config) |
| `redis` | `@devvit/web/server` | Session + event store, fingerprint store, flag store, whitelist set |
| `scheduler` | `@devvit/web/server` | Daily fingerprint cleanup + 30-min resweep |
| `settings` | `@devvit/web/server` | API key (secret), repost threshold, toggles |
| Triggers | `devvit.json` → `/internal/triggers/*` | `onPostCreate`, `onPostDelete`, `onAppInstall` |
| Menu items | `devvit.json` → `/internal/menu/*` | Open ModPilot, check post for reposts, seed test posts, clean up repost data, mop |
| Forms | `devvit.json` → `/internal/form/*` | Confirmation dialogs for mop + clean-up actions |
| Web-view post | `devvit.json` → `post.entrypoints.default` | ModPilot chat HTML lives in `src/client/` |
| HTTP fetch | `permissions.http.domains` | Whitelist Gemini + Reddit image CDNs |

## Repo layout

```
src/
  index.ts            Hono bootstrap, route mounting
  core/
    nuke.ts           Original Mop bulk-comment logic (untouched)
    gemini.ts         Gemini API wrappers (embed, vision, rule classification)
    fingerprint.ts    Redis fingerprint + flag + whitelist + retry store
    similarity.ts     Cosine sim + scoring helpers
    repost.ts         Repost pipeline: index → match → flag; resweep + cleanup
    automod/
      schema.ts       Exact AutoMod schema constants (from reddit's engine)
      parse.ts        Multi-doc YAML → rule blocks; key/modifier decoding
      validate.ts     Validate config vs schema (blocks invalid writes pre-415)
    modpilot/
      agent.ts        Agent loop (turn-ceiling + stop/interrupt), event streaming
      llm.ts          Gemini chat + function-calling wrapper
      prompt.ts       System prompt (rules: read-before-write, lead-in-then-act, etc.)
      session.ts      Redis session + event + interrupt + preamble store
      tools.ts        Tool registry (read / analyze / mutate); 28 tools
                      (incl. get_automod_config / update_automod_config)
  routes/
    api.ts            Web-view backend (health only)
    chat.ts           Chat endpoints + /whoami mod gate (all gated by requireMod)
    forms.ts          Form submit handlers (mop, clean-repost-data)
    menu.ts           Menu actions (open ModPilot, check-post, seed, clean-up, mop)
    triggers.ts       Event handlers (AppInstall, PostCreate, PostDelete)
    jobs.ts           Scheduler task endpoints (cleanup, resweep)
  client/
    chat.html         ModPilot chat UI shell
    chat.css          Dark-only styles, responsive flex layout
    chat.js           Chat logic — polling, typewriter, load skeleton + cache, mod gate
devvit.json           App config (permissions, triggers, menu, forms, jobs).
                      `post.dir` = "src/client" so the CLI's Static-mode
                      validation finds the entry at the expected path. The
                      Vite plugin auto-detects src/client as the client root.
```

## Redis key layout

```
# Repost detection
fp:{postId}                          hash: {title, perm, embed (base64), imageEmbedding? (base64), imageDescription, createdAt}
fp:index                             zset by createdAt unix-ms, member = postId
fp:retry                             zset by createdAt, member = postId (embeds that failed at index time)
flag:{postId}                        hash: {originalPostId, score, textSim, imageSim, status, createdAt, reviewedBy?, reviewedAt?}
flag:queue                           zset by ts, member = postId (open flags only)
whitelist:{a}:{b}                    string "1" — "mod marked pair as not-a-repost"
modpilot:repost:last-cleanup         hash: {ts, removed, cutoff}
modpilot:repost:last-resweep         hash: {ts, retried, pruned, scanned, flagged, staleChecked, stalePruned}

# flag status: open | confirmed | dismissed. remove_post → confirmed, approve_post
# → dismissed; pruneStaleFlags reconciles open flags vs live Reddit (foreign/gone
# → delete, already-removed → confirmed).

# ModPilot sessions
modpilot:sessions:{userId}                  zset by createdAt, member = sessionId
modpilot:session:{sessionId}                hash: meta (title, sub, user, approvalMode, ts)
modpilot:session:{sessionId}:msgs           hash: seq → JSON Gemini message
modpilot:session:{sessionId}:msg_count      counter (incrBy seq)
modpilot:session:{sessionId}:events         hash: seq → JSON event
modpilot:session:{sessionId}:event_count    counter
modpilot:session:{sessionId}:run            string: idle | running | awaiting_approval | done | error
modpilot:session:{sessionId}:turns          per-run turn counter (survives approval suspend/resume)
modpilot:session:{sessionId}:pending        JSON: a mutation parked for manual approval + its queued siblings
modpilot:session:{sessionId}:interrupt      string "1" — cooperative stop flag (stop button)
modpilot:session:{sessionId}:preamble       string "1" — one lead-in line already streamed this message
```

## Build / dev commands

```
npm run dev          # devvit playtest (uploads on change to dev subreddit)
npm run build        # vite build → dist/server/index.cjs + dist/client
npm run type-check   # tsc --build (strict)
npm run lint         # eslint
npm run deploy       # type-check + lint + test + devvit upload
npm run launch       # deploy + devvit publish
```

Dev subreddit: `tesmoddapp_dev` (set in `devvit.json` `dev.subreddit`).

⚠️ **`deploy`/`launch` are currently broken**: their chain runs `npm run test`
(`vitest run`), but vitest isn't installed and there are no tests, so it aborts
before uploading. To publish, either run `devvit upload` / `devvit publish`
directly (upload triggers `vite build` via `devvit.json` `scripts.build`), or
drop `npm run test &&` from the `deploy` script.

Access control: the web-view is moderators-only. `chat.ts` `/whoami` lets the
client show a block screen on load; every other `/api/chat/*` endpoint calls
`requireMod()` (403 for non-mods) — that server check is the real enforcement.

## Secrets

Set after first install via the subreddit's app settings page:
- `geminiApiKey` — Google AI Studio free-tier key (https://aistudio.google.com/apikey)

## External API domains (must stay whitelisted in `devvit.json`)

- `generativelanguage.googleapis.com` — Gemini
- `i.redd.it`, `preview.redd.it`, `external-preview.redd.it`, `i.imgur.com` — Reddit + Imgur image CDNs (for fetching to send to Gemini Vision)

## Pointers

- Devvit docs: https://developers.reddit.com/docs
- Devvit Web overview: https://developers.reddit.com/docs/devvit-web
- Reddit API client reference: `node_modules/@devvit/reddit/RedditClient.d.ts`
- Config schema: https://developers.reddit.com/schema/config-file.v1.json
- Gemini embedding API: https://ai.google.dev/api/embeddings
- Gemini function calling: https://ai.google.dev/gemini-api/docs/function-calling
