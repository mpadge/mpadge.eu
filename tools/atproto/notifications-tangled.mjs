// Recent activity on your Tangled (https://tangled.org) repos, as "unread" notifications.
//
//   node tools/atproto/notifications-tangled.mjs [--json] [--actor=other.handle]
//   node tools/atproto/notifications-tangled.mjs --mark-seen    # also remember what was shown
//
// (notifications.mjs --unread runs this together with the Bluesky and Semble scripts.)
//
// Tangled has no notifications API (the inbox is web-app state), so this approximates one from
// Bobbin, Tangled's public read-only AppView (https://api.tangled.org, org.tangled.* XRPC; no login):
// for each repo you own it lists stars, issues and pull requests, new comments on them, and, for
// you, new follows. "Unread" means "not seen on an earlier --mark-seen run": by default this only
// READS, so repeated runs show the same things until you pass --mark-seen. Your own activity is
// skipped. Not covered: repos you only collaborate on, mentions elsewhere (use the Jetstream scan
// in notifications-bluesky.mjs), and anything deleted.
//
// The seen-state is a small JSON file: $TANGLED_STATE_FILE, else
// $XDG_STATE_HOME/mpadge-atproto/tangled-seen.json, else ~/.local/state/mpadge-atproto/tangled-seen.json.
// On the first run (no file) only items from the last 7 days are shown (--since=3d, 12h, ... to
// change), and existing comment counts become the baseline.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { publicAgent, paginate, handleOf, describeError } from './agent.mjs';
import { argValue, printNotification } from './notifications-common.mjs';

const BOBBIN = process.env.TANGLED_API_URL || 'https://api.tangled.org';
const WEB = 'https://tangled.org';

const stateFile = () => process.env.TANGLED_STATE_FILE
  || path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'mpadge-atproto', 'tangled-seen.json');
const loadState = () => { try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')); } catch { return undefined; } };
function saveState(seen) {
  const file = stateFile();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify({ seen }));
}

// org.tangled.* XRPC GET. @atproto/api's agent.call() only accepts lexicons the SDK knows, and it has
// none for org.tangled.*, so this is a plain fetch (like Semble and Constellation).
async function bobbin(method, params) {
  const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]));
  const res = await fetch(`${BOBBIN}/xrpc/org.tangled.${method}?${q}`);
  if (!res.ok) throw new Error(`${method}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}
// List method -> all items (cursor-paged).
const listAll = (method, params) => paginate((cursor) => bobbin(method, { ...params, limit: 100, cursor }), (r) => r.items);

const parseSince = (s) => {
  const m = /^(\d+(?:\.\d+)?)([smhd])$/.exec(s);
  if (!m) throw new Error(`Cannot parse --since=${s}`);
  return Number(m[1]) * { s: 1e3, m: 6e4, h: 36e5, d: 864e5 }[m[2]];
};
const didOf = (uri) => uri.split('/')[2];
const rkeyOf = (uri) => uri.split('/').pop();
const oneLine = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 200);

// Returns { count, items } in the common notification shape; prints nothing (unless --mark-seen
// writes the state file).
export async function unread({ actor = 'mpadge.eu' } = {}) {
  try {
    const { data: profile } = await publicAgent().app.bsky.actor.getProfile({ actor });
    const me = profile.did;
    const state = loadState();
    const first = !state;
    const seen = state?.seen || {};
    const cutoff = Date.now() - parseSince(argValue('since') || '7d');
    // Shown if never seen and (not the first run, or recent enough).
    const isNew = (key, createdAt) => !(key in seen) && (!first || Date.parse(createdAt) >= cutoff);
    const nowSeen = {};
    const items = [];
    const add = async (who, it) => items.push({ service: 'tangled', handle: await handleOf(who), did: who, ...it });

    // Repos you own: the manifest record lives in each repo's own DID.
    const repos = (await listAll('repo.listRepos', { subject: me })).map((r) => ({
      did: didOf(r.uri), name: r.value?.declaration?.name, owner: r.value?.declaration?.owner,
    })).filter((r) => r.name && r.owner === me);
    const base = (r) => `${WEB}/${profile.handle}/${r.name}`;

    for (const f of await listAll('graph.listFollows', { subject: me })) {
      nowSeen[f.uri] = 1;
      if (isNew(f.uri, f.value?.createdAt)) await add(didOf(f.uri), { time: f.value.createdAt, reason: 'follow', uri: f.uri, url: `${WEB}/${await handleOf(didOf(f.uri))}` });
    }

    for (const r of repos) {
      for (const s of await listAll('feed.listStars', { subject: r.did })) {
        nowSeen[s.uri] = 1;
        if (didOf(s.uri) !== me && isNew(s.uri, s.value?.createdAt)) {
          await add(didOf(s.uri), { time: s.value.createdAt, reason: 'star', uri: s.uri, text: `starred ${r.name}`, url: base(r) });
        }
      }
      for (const [method, reason, route] of [['repo.listIssues', 'issue', 'issues'], ['repo.listPulls', 'pull', 'pulls']]) {
        for (const t of await listAll(method, { subject: r.did })) {
          const url = `${base(r)}/${route}/${rkeyOf(t.uri)}`;
          const title = oneLine(t.value?.title?.text);
          const had = seen[t.uri];
          nowSeen[t.uri] = t.commentCount ?? 0;
          if (t.author !== me && isNew(t.uri, t.value?.createdAt)) {
            await add(t.author, { time: t.value.createdAt, reason, uri: t.uri, text: `${r.name}: ${title}`, url });
          } else if (typeof had === 'number' && (t.commentCount ?? 0) > had) {
            // Existing, already-seen thread with new comments: show the newest ones (not yours).
            const n = t.commentCount - had;
            const comments = (await bobbin('feed.listComments', { subject: t.uri, limit: Math.min(n, 100), order: 'desc' })).items;
            for (const c of comments) {
              if (c.editor === me) continue;
              await add(c.editor || didOf(c.uri), { time: c.createdAt, reason: 'comment', uri: c.uri, text: `${r.name}: ${title}\n${oneLine(c.body?.text)}`, url });
            }
          }
        }
      }
    }
    items.sort((a, b) => b.time.localeCompare(a.time));
    if (process.argv.includes('--mark-seen')) saveState(nowSeen);
    return { count: items.length, items };
  } catch (e) {
    throw new Error(`Tangled request failed: ${describeError(e)}`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { count, items } = await unread({ actor: argValue('actor') || 'mpadge.eu' });
  console.error(`# ${count} new on Tangled (Bobbin; not an official unread count)`);
  for (const n of items) printNotification(n, process.argv.includes('--json'));
  process.exit(0);
}
