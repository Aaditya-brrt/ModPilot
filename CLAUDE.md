# CLAUDE.md

Project context for AI assistants working in this repo.

## What this is

**ModPilot** — a Devvit moderation copilot for Reddit. Mods chat with it in a
web-view ("Cursor for mod work"); the agent reads subreddit state with read
tools and takes moderation actions (remove, lock, ban, modmail, mod-notes,
etc.) with mandatory `confirmation` sentences on every mutation. Built for the
[Reddit Mod Tools & Migrated Apps Hackathon](https://mod-tools-migration.devpost.com/)
(submission deadline **May 27 2026, 6pm PDT**).

Repost detection is one tool inside ModPilot, not a separate app:
1. `onPostCreate` trigger fingerprints every new post (title + body + Gemini
   image description → `gemini-embedding-2` vector, 768 dims via
   `outputDimensionality`).
2. Compares vector against recent posts stored in Redis (sliding window).
3. If cosine similarity ≥ threshold, flags the post: stores flag in Redis,
   posts an auto-comment linking the original, reports to modqueue.
4. The agent surfaces these flags through the `list_flagged_reposts` and
   `check_post_for_repost` tools so a mod can ask "show me reposts from the
   last 24h" in natural language.

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
  chat + function calling, `gemini-embedding-2` (768-dim via
  `outputDimensionality`) for repost embeddings, and `gemini-2.5-flash`
  vision for image descriptions. API key stored as Devvit secret setting
  `geminiApiKey`. Embedding spaces between `gemini-embedding-2` and the older
  `text-embedding-004` / `gemini-embedding-001` are **incompatible** — any
  old fingerprints in Redis must be cleared on model change.

## Devvit primitives in use

| Primitive | Where | Why |
|---|---|---|
| `reddit` client | `@devvit/web/server` | Read posts, submit comments, report, ban, approve, modmail, mod-notes |
| `redis` | `@devvit/web/server` | Session + event store, fingerprint store, flag store, whitelist set |
| `scheduler` | `@devvit/web/server` | Daily fingerprint cleanup |
| `settings` | `@devvit/web/server` | API key (secret), repost threshold, toggles |
| Triggers | `devvit.json` → `/internal/triggers/*` | `onPostCreate`, `onPostDelete`, `onAppInstall` |
| Menu items | `devvit.json` → `/internal/menu/*` | Open ModPilot, check post for reposts, seed test posts, mop |
| Forms | `devvit.json` → `/internal/form/*` | Confirmation dialogs for mop actions |
| Web-view post | `devvit.json` → `post.entrypoints.default` | ModPilot chat HTML lives in `src/client/` |
| HTTP fetch | `permissions.http.domains` | Whitelist Gemini + Reddit image CDNs |

## Repo layout

```
src/
  index.ts            Hono bootstrap, route mounting
  core/
    nuke.ts           Original Mop bulk-comment logic (untouched)
    gemini.ts         Gemini API wrappers (embed, vision)
    fingerprint.ts    Redis fingerprint + flag + whitelist store
    similarity.ts     Cosine sim + scoring helpers
    repost.ts         Repost-detection pipeline: index → match → flag
    modpilot/
      agent.ts        Agent loop (max 8 turns), event streaming
      llm.ts          Gemini chat + function-calling wrapper
      prompt.ts       System prompt (rules: read-before-write, etc.)
      session.ts      Redis session + event store (hash + counter)
      tools.ts        Tool registry (read / analyze / mutate)
  routes/
    api.ts            Web-view backend (health only)
    chat.ts           Chat endpoints: /session, /sessions, /:id/message, /:id/events
    forms.ts          Form submit handlers (mop)
    menu.ts           Menu actions (open ModPilot, check-post, seed, mop)
    triggers.ts       Event handlers (AppInstall, PostCreate, PostDelete)
    jobs.ts           Scheduler task endpoint (cleanup)
  client/
    chat.html         ModPilot chat UI shell
    chat.css          Dark-theme styles, responsive flex layout
    chat.js           Chat logic — single-flight polling of /events
devvit.json           App config (permissions, triggers, menu, forms, jobs).
                      `post.dir` = "src/client" so the CLI's Static-mode
                      validation finds the entry at the expected path. The
                      Vite plugin auto-detects src/client as the client root.
```

## Redis key layout

```
# Repost detection
fp:{postId}                          hash: {title, perm, ts, embed (base64), imgDesc?}
fp:index                             zset by createdAt unix-ms, member = postId
flag:{postId}                        hash: {originalId, score, breakdown, ts, status}
flag:queue                           zset by ts, member = postId (open flags only)
whitelist:{a}:{b}                    string "1" — "mod marked pair as not-a-repost"
modpilot:repost:last-cleanup         hash: {ts, removed, cutoff}

# ModPilot sessions
modpilot:sessions:{userId}           zset by createdAt, member = sessionId
modpilot:session:{sessionId}         hash: meta (title, sub, user, ts)
modpilot:session:{sessionId}:msgs    hash: seq → JSON Gemini message
modpilot:session:{sessionId}:msg_count   counter (incrBy seq)
modpilot:session:{sessionId}:events  hash: seq → JSON event
modpilot:session:{sessionId}:event_count counter
modpilot:session:{sessionId}:run     string: idle | running | done | error
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
