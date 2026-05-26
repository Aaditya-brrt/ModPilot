import { Hono } from 'hono';
import type { MenuItemRequest, UiResponse } from '@devvit/web/shared';
import type { FormField } from '@devvit/shared-types/shared/form.js';
import { reddit } from '@devvit/web/server';
import type { Post } from '@devvit/web/server';

export const menu = new Hono();

const buildNukeFields = (targetId: string): FormField[] => [
  {
    name: 'targetId',
    label: 'Target ID',
    type: 'string',
    helpText: 'Auto-filled from the selected item.',
    required: true,
    defaultValue: targetId,
  },
  {
    name: 'remove',
    label: 'Remove comments',
    type: 'boolean',
    defaultValue: true,
  },
  {
    name: 'lock',
    label: 'Lock comments',
    type: 'boolean',
    defaultValue: false,
  },
  {
    name: 'skipDistinguished',
    label: 'Skip distinguished comments',
    type: 'boolean',
    defaultValue: false,
  },
];

const buildNukeForm = (title: string, targetId: string) => ({
  fields: buildNukeFields(targetId),
  title,
  acceptLabel: 'Mop',
  cancelLabel: 'Cancel',
});

menu.post('/mop-comment', async (c) => {
  const request = await c.req.json<MenuItemRequest>();
  return c.json<UiResponse>(
    {
      showForm: {
        name: 'mopComment',
        form: buildNukeForm('Mop Comments', request.targetId),
      },
    },
    200
  );
});

menu.post('/mop-post', async (c) => {
  const request = await c.req.json<MenuItemRequest>();
  return c.json<UiResponse>(
    {
      showForm: {
        name: 'mopPost',
        form: buildNukeForm('Mop Post Comments', request.targetId),
      },
    },
    200
  );
});

menu.post('/open-modpilot', async (c) => {
  try {
    const subreddit = await reddit.getCurrentSubreddit();
    const post = await reddit.submitCustomPost({
      subredditName: subreddit.name,
      title: 'ModPilot',
      splash: {
        appDisplayName: 'ModPilot',
        heading: 'ModPilot',
        description: 'Natural-language moderation copilot',
        buttonLabel: 'Open ModPilot',
      },
    });
    return c.json<UiResponse>(
      {
        navigateTo: `https://www.reddit.com${post.permalink}`,
        showToast: 'ModPilot post created. Opening…',
      },
      200
    );
  } catch (err) {
    console.error('[modpilot] open-modpilot failed', err);
    return c.json<UiResponse>(
      { showToast: 'Could not create the ModPilot post. Check logs.' },
      200
    );
  }
});

menu.post('/seed-test-posts', async (c) => {
  await c.req.json<MenuItemRequest>();
  try {
    const subreddit = await reddit.getCurrentSubreddit();

    // Pull cute image posts from r/aww for repost testing.
    const hot = await reddit
      .getHotPosts({ subredditName: 'aww', limit: 60 })
      .all();
    const images = hot.filter(
      (p) =>
        typeof p.url === 'string' &&
        /^https:\/\/i\.redd\.it\/.+\.(jpg|jpeg|png|webp)(\?.*)?$/i.test(p.url)
    );
    const uniqueImgs = images.slice(0, 4);
    if (uniqueImgs.length < 3) {
      return c.json<UiResponse>(
        { showToast: `Only found ${uniqueImgs.length} image posts on r/aww. Try later.` },
        200
      );
    }

    type SeedItem =
      | { kind: 'link'; title: string; url: string; category: string }
      | { kind: 'text'; title: string; text: string; category: string };

    const plan: SeedItem[] = [];

    // ============ REPOST DETECTION ============
    // Goal: exercise check_post_for_repost + repost reports surfacing in the modqueue.
    for (const p of uniqueImgs) {
      plan.push({ kind: 'link', title: p.title, url: p.url, category: 'image-original' });
    }
    // Rephrased dupes — repost detection should still catch via embedding + vision desc.
    const rephrased = [
      'Has anyone else seen this adorable little one?',
      'Look at this absolute unit, my heart cannot take it',
      'Caught my buddy mid-zoomies, send help',
    ];
    for (let i = 0; i < Math.min(rephrased.length, uniqueImgs.length); i++) {
      plan.push({
        kind: 'link',
        title: rephrased[i]!,
        url: uniqueImgs[i]!.url,
        category: 'image-rephrased-dupe',
      });
    }

    // ============ TEXT REPOST ============
    const streamingBase: SeedItem = {
      kind: 'text',
      title: 'What is your unpopular opinion on streaming services?',
      text:
        'I genuinely think most streaming services have become worse than cable. ' +
        "You're paying more in aggregate, ads are creeping back in, and exclusives are scattered everywhere.",
      category: 'text-original',
    };
    plan.push(streamingBase);
    plan.push({
      kind: 'text',
      title: 'Unpopular take on streaming services — agree or disagree?',
      text: streamingBase.kind === 'text' ? streamingBase.text : '',
      category: 'text-rephrased-dupe',
    });

    // ============ SPAM / SCAM ============
    // Goal: "find recent scam posts and remove them, ban the authors"
    plan.push({
      kind: 'text',
      title: 'FREE airdrop drop here join t.me/totallylegitcrypto to claim 5 ETH',
      text:
        'Limited time only! First 100 users get 5 ETH instantly. Just verify your wallet at notascam-airdrop.example.com and join our telegram t.me/totallylegitcrypto. DM me proof of joining for bonus.',
      category: 'spam-crypto',
    });
    plan.push({
      kind: 'text',
      title: 'I made $5,000 in one week using this ONE WEIRD TRICK',
      text:
        "DM me 'INFO' and I'll send you the strategy. Not financial advice but this changed my life. Pinky promise. Click link in bio: gettrichquick.example.com",
      category: 'spam-make-money',
    });
    plan.push({
      kind: 'text',
      title: '🔥🔥🔥 FREE ROBUX WORKING 2026 NO HUMAN VERIFICATION 🔥🔥🔥',
      text:
        'Use generator at robux-totally-real.example.com — works on all accounts. Share with friends. Limited stock!',
      category: 'spam-robux',
    });

    // ============ ALL-CAPS / TITLE RULE VIOLATIONS ============
    // Goal: "remove posts with all-caps titles longer than 30 chars"
    plan.push({
      kind: 'text',
      title: 'PLEASE EVERYONE UPVOTE THIS POST TO THE TOP OF THE SUBREDDIT RIGHT NOW',
      text: 'I really need karma for my main account, please help out a fellow redditor.',
      category: 'rule-violation-caps',
    });
    plan.push({
      kind: 'text',
      title: 'WHY DOES NOBODY EVER ANSWER ANY OF MY QUESTIONS IN THIS SUB',
      text: 'Asking the same thing for the third time and getting zero responses. Pathetic community.',
      category: 'rule-violation-caps',
    });

    // ============ LOW-EFFORT ============
    // Goal: "find low-effort posts (very short titles + empty bodies) and remove"
    plan.push({
      kind: 'text',
      title: 'lol',
      text: '.',
      category: 'low-effort',
    });
    plan.push({
      kind: 'text',
      title: 'this',
      text: 'idk just felt like posting',
      category: 'low-effort',
    });

    // ============ KARMA / ENGAGEMENT BAIT ============
    plan.push({
      kind: 'text',
      title: 'Upvote if you agree breakfast is the best meal of the day',
      text: 'Just an upvote, no comment needed. Let’s see how many we can get!',
      category: 'engagement-bait',
    });
    plan.push({
      kind: 'text',
      title: "Comment 'first' for good luck the entire week",
      text: 'Trust me it works. I commented first on a post last month and got promoted.',
      category: 'engagement-bait',
    });

    // ============ SELF-PROMO ============
    // Goal: "find self-promotion violations (links to YouTube/Etsy etc.) — flag for review"
    plan.push({
      kind: 'text',
      title: 'Check out my new YouTube channel — gaming content every day, please subscribe!',
      text:
        'Hey everyone, I just launched a channel where I post Minecraft and Fortnite content daily. ' +
        'It would mean the world if you subscribed: youtube.com/@notarealchannel-promo',
      category: 'self-promo',
    });
    plan.push({
      kind: 'text',
      title: 'Just launched my Etsy shop with handmade jewelry — link in bio!',
      text:
        'Three years of designing, finally selling. Use code REDDIT10 for 10% off. ' +
        'etsy.com/shop/notarealetsyshop',
      category: 'self-promo',
    });

    // ============ INFLAMMATORY / RULE-BREAKING TONE ============
    // Satirical hot-takes targeting absurd things (shopping carts, pineapple pizza, light theme)
    // so the pattern is testable for an inflammatory-tone classifier without harming anyone.
    plan.push({
      kind: 'text',
      title: 'People who don’t return shopping carts are the worst kind of humans alive',
      text:
        'Every single one of them is a menace to society and personally responsible for the decline of civilization. Fight me.',
      category: 'inflammatory-satire',
    });
    plan.push({
      kind: 'text',
      title: 'Anyone who likes pineapple on pizza should be banned from this subreddit',
      text:
        'It is a crime against humanity. Mods please permaban every single one of them on sight. ' +
        'I will die on this hill.',
      category: 'inflammatory-satire',
    });
    plan.push({
      kind: 'text',
      title: 'Light theme users are not real developers and never will be',
      text:
        'Sorry, but if you use light theme in your IDE you are objectively wrong and should not be hired anywhere.',
      category: 'inflammatory-satire',
    });

    // ============ UNTAGGED SPOILER ============
    // Goal: "find posts with untagged spoilers for major movies"
    plan.push({
      kind: 'text',
      title: 'Avengers Endgame ending: Tony Stark dies at the end, what a letdown',
      text:
        'Just watched it for the first time and wow that was anticlimactic. Anyone else feel the same? ' +
        '(no spoiler tag on purpose, sue me)',
      category: 'untagged-spoiler',
    });

    // ============ BRIGADING / DRAMA STARTER ============
    plan.push({
      kind: 'text',
      title: 'Why is everyone in this sub so toxic lately? Downvote brigade incoming',
      text:
        'Posted a perfectly reasonable take yesterday and got mass-downvoted by the same 5 accounts. ' +
        'This sub used to be good. What happened?',
      category: 'drama',
    });

    // ============ EXECUTE ============
    // ============ ADD TEST RULES ============
    // Powers `get_subreddit_rules` testing. Idempotent: rule names must be unique,
    // so a 2nd seed will fail per-rule but the seed continues.
    const testRules: Array<{
      shortName: string;
      description: string;
      kind: 'all' | 'link' | 'comment';
    }> = [
      {
        shortName: 'No spam or scams',
        description:
          'No crypto airdrops, get-rich-quick schemes, free-Robux generators, or affiliate-link farming. Bans on sight.',
        kind: 'all',
      },
      {
        shortName: 'No low-effort posts',
        description:
          'Titles under 10 characters, empty bodies, or single-word posts (lol, this, ok) will be removed.',
        kind: 'link',
      },
      {
        shortName: 'No engagement bait',
        description:
          '"Upvote if you agree", "comment first for luck", and similar bait posts are not allowed.',
        kind: 'link',
      },
      {
        shortName: 'Self-promo limits',
        description:
          'Posts promoting your YouTube, Etsy, Twitch, or other channels must follow the 9:1 rule (nine community posts for every self-promo).',
        kind: 'link',
      },
      {
        shortName: 'Tag spoilers properly',
        description:
          'All posts containing plot details from movies/shows/games less than 30 days old must use the spoiler tag in the title.',
        kind: 'link',
      },
    ];
    let rulesAdded = 0;
    for (const r of testRules) {
      try {
        await reddit.createRule(subreddit.name, r);
        rulesAdded++;
      } catch (e) {
        // Likely already exists from a prior seed — fine.
        console.log(`[modpilot] rule skip "${r.shortName}": ${String(e).slice(0, 100)}`);
      }
    }
    console.log(`[modpilot] rules added: ${rulesAdded}/${testRules.length}`);

    // ============ SUBMIT POSTS, CAPTURING IDS PER CATEGORY ============
    let created = 0;
    let failed = 0;
    const byCategory: Record<string, number> = {};
    const submittedByCategory: Record<string, Post[]> = {};
    for (const item of plan) {
      try {
        const post =
          item.kind === 'link'
            ? await reddit.submitPost({
                subredditName: subreddit.name,
                title: item.title.slice(0, 280),
                url: item.url,
              })
            : await reddit.submitPost({
                subredditName: subreddit.name,
                title: item.title.slice(0, 280),
                text: item.text,
              });
        created++;
        byCategory[item.category] = (byCategory[item.category] ?? 0) + 1;
        if (!submittedByCategory[item.category]) submittedByCategory[item.category] = [];
        submittedByCategory[item.category]!.push(post);
        await new Promise((r) => setTimeout(r, 3500));
      } catch (err) {
        failed++;
        console.error('[modpilot] seed item failed', item.category, item.title, err);
      }
    }

    // ============ REPORT 3 SPAM POSTS ============
    // Populates modqueue + userReportReasons in postSummary.
    const spamPool = [
      ...(submittedByCategory['spam-crypto'] ?? []),
      ...(submittedByCategory['spam-make-money'] ?? []),
      ...(submittedByCategory['spam-robux'] ?? []),
    ];
    let reportsFiled = 0;
    for (const post of spamPool.slice(0, 3)) {
      try {
        await reddit.report(post, { reason: 'Looks like scam/spam content' });
        reportsFiled++;
      } catch (e) {
        console.warn('[modpilot] report failed', post.id, String(e).slice(0, 100));
      }
    }
    console.log(`[modpilot] reports filed: ${reportsFiled}`);

    // ============ FILTER 2 CAPS-VIOLATION POSTS ============
    // Pushes them straight to modqueue without removing.
    const capsPool = submittedByCategory['rule-violation-caps'] ?? [];
    let filtered = 0;
    for (const post of capsPool.slice(0, 2)) {
      try {
        await post.filter('Possible rule violation (all-caps title)', true);
        filtered++;
      } catch (e) {
        console.warn('[modpilot] filter failed', post.id, String(e).slice(0, 100));
      }
    }
    console.log(`[modpilot] posts filtered: ${filtered}`);

    // ============ CREATE 3 INTERNAL MODMAIL THREADS ============
    const modmailThreads: Array<{ subject: string; body: string }> = [
      {
        subject: 'Brigade incoming on yesterday\'s drama thread',
        body:
          'A bunch of new accounts are flooding the controversial post from yesterday with low-effort takes. ' +
          'Should we lock or just let it run its course? Curious what others think.',
      },
      {
        subject: 'Need second opinion on u/repeat_offender',
        body:
          'They are at 3 confirmed reposts this month plus an engagement-bait post yesterday. ' +
          'I am leaning towards a 30-day ban but would like a second pair of eyes before pulling the trigger.',
      },
      {
        subject: 'AutoMod rule proposal: filter all-caps titles',
        body:
          'We have been getting a wave of LOOK AT THIS NOW EVERYONE posts. ' +
          'Proposing an AutoMod rule that filters titles where >70% of characters are uppercase. ' +
          'Anyone object before I add it?',
      },
    ];
    let modmailsCreated = 0;
    for (const m of modmailThreads) {
      try {
        await reddit.modMail.createConversation({
          subredditName: subreddit.name,
          subject: m.subject.slice(0, 100),
          body: m.body,
          to: null,
        });
        modmailsCreated++;
      } catch (e) {
        console.warn('[modpilot] modmail failed', m.subject, String(e).slice(0, 100));
      }
    }
    console.log(`[modpilot] modmail threads created: ${modmailsCreated}`);

    // ============ ADD 2 MOD NOTES ON SEEDER ============
    let notesAdded = 0;
    try {
      const me = await reddit.getCurrentUser();
      if (me) {
        const seederNotes: Array<{
          note: string;
          label?:
            | 'BOT_BAN'
            | 'PERMA_BAN'
            | 'BAN'
            | 'ABUSE_WARNING'
            | 'SPAM_WARNING'
            | 'SPAM_WATCH'
            | 'SOLID_CONTRIBUTOR'
            | 'HELPFUL_USER';
        }> = [
          {
            note: 'Seeded test data for ModPilot demo. Active mod, no real issues.',
            label: 'HELPFUL_USER',
          },
          {
            note: 'Reminder: appealed warning for a low-effort post in March 2026. Resolved.',
            label: 'SPAM_WARNING',
          },
        ];
        for (const n of seederNotes) {
          try {
            const opts: Parameters<typeof reddit.addModNote>[0] = {
              subreddit: subreddit.name,
              user: me.username,
              note: n.note.slice(0, 250),
            } as Parameters<typeof reddit.addModNote>[0];
            if (n.label) (opts as Record<string, unknown>).label = n.label;
            await reddit.addModNote(opts);
            notesAdded++;
          } catch (e) {
            console.warn('[modpilot] mod note failed', String(e).slice(0, 100));
          }
        }
      }
    } catch (e) {
      console.warn('[modpilot] could not get current user for mod notes', String(e).slice(0, 100));
    }
    console.log(`[modpilot] mod notes added: ${notesAdded}`);

    const breakdown = Object.entries(byCategory)
      .map(([k, v]) => `${k}:${v}`)
      .join(', ');
    console.log(`[modpilot] seed complete — posts ${created}/${plan.length} | ${breakdown}`);
    const msg =
      `Seeded ${created}/${plan.length} posts` +
      (failed > 0 ? ` (${failed} failed)` : '') +
      ` · ${rulesAdded} rules · ${reportsFiled} reports · ${filtered} filtered · ${modmailsCreated} modmails · ${notesAdded} mod notes.`;
    return c.json<UiResponse>({ showToast: msg.slice(0, 150) }, 200);
  } catch (err) {
    console.error('[modpilot] seed-test-posts failed', err);
    return c.json<UiResponse>(
      { showToast: 'Seed failed. Check logs.' },
      200
    );
  }
});

menu.post('/clean-repost-data', async (c) => {
  await c.req.json<MenuItemRequest>();
  return c.json<UiResponse>(
    {
      showForm: {
        name: 'cleanRepostData',
        form: {
          fields: [],
          title: 'Clean up repost data',
          description:
            'Reconciles flagged reposts against live Reddit (drops deleted/foreign ones, ' +
            'resolves already-removed posts) and prunes fingerprints older than the lookback ' +
            'window. Only stale/leftover data is removed — valid in-window data is kept.',
          acceptLabel: 'Clean up',
          cancelLabel: 'Cancel',
        },
      },
    },
    200
  );
});

menu.post('/check-post', async (c) => {
  const request = await c.req.json<MenuItemRequest>();
  try {
    const post = await reddit.getPostById(request.targetId as `t3_${string}`);
    const { processNewPost } = await import('../core/repost');
    const match = await processNewPost(post);
    if (!match) {
      return c.json<UiResponse>(
        { showToast: 'ModPilot found no repost match for this post.' },
        200
      );
    }
    return c.json<UiResponse>(
      {
        showToast: `Match found: ${match.combined.toFixed(1)}% with ${match.originalPostId}`,
      },
      200
    );
  } catch (err) {
    console.error('[modpilot:repost] check-post failed', err);
    return c.json<UiResponse>(
      { showToast: 'Check failed. See logs.' },
      200
    );
  }
});
