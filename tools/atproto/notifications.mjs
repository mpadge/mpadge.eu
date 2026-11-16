// List notifications for an account, in one of two ways:
//   --unread  ask the Bluesky AppView for your unread notifications (fast; needs login)
//   (default) scan the complete Jetstream feed (slow; no login; catches records from any app)
//
//   node tools/atproto/notifications.mjs --unread              # unread notifications, via the AppView
//   node tools/atproto/notifications.mjs --unread --json
//
// --unread logs in as publish.mjs does: ATPROTO_IDENTIFIER (default: --actor, i.e. mpadge.eu),
// ATPROTO_APP_PASSWORD (default: first line of `pass show atproto/app-password`) and
// ATPROTO_PDS (default https://tngl.sh). The "unread" state is a `seenAt` timestamp kept by the
// AppView for your account, not a record in your repo. This only READS it: updateSeen is never
// called, so your unread badge in the Bluesky app is left alone. The AppView only reports what it
// indexes (Bluesky-lexicon activity, after your mutes/blocks), and prunes old notifications.
//
// The rest of this header describes the Jetstream scan.
//
//   node tools/atproto/notifications.mjs                       # --once (default): scan the last 24h, then exit
//   node tools/atproto/notifications.mjs --since=6h            # scan from 6 hours ago (max ~24h), then exit
//   node tools/atproto/notifications.mjs --since=2026-11-15T09:00:00Z
//   node tools/atproto/notifications.mjs --follow              # after catching up, keep streaming live until Ctrl+C
//   node tools/atproto/notifications.mjs --follow --duration=10m   # ... but stop after 10 minutes
//   node tools/atproto/notifications.mjs --json                # JSON lines instead of text
//   node tools/atproto/notifications.mjs --state=.notif-cursor # resume from where the last run stopped
//   node tools/atproto/notifications.mjs --actor=other.handle
//
// How it works:
//  - Notifications are not records in your repo. They are other people's records that point
//    at you, so the only way to see all of them, from every app and lexicon and not just
//    Bluesky, is to watch every new record in the network and keep those that mention you.
//  - Jetstream is connected WITHOUT any `wantedCollections` filter, so it delivers every
//    commit from every repo (several hundred events/s; expect a few Mbit/s of traffic).
//    Collection-filtered feeds would hide records from other lexicons.
//  - Jetstream cannot filter by mention, so each record is scanned client-side: any string in
//    it that contains your DID (at://<did>/..., a bare DID, a mention facet) counts as a hit.
//    Records you authored yourself are skipped.
//  - Hits are classified by where the DID is found: like / repost / follow / reply / quote /
//    mention for app.bsky.*, and a generic "reference" for any other collection.
//  - Default is --once: replay from --since (default 24h ago, or the --state cursor) until the
//    stream has caught up with the present, print a summary, and exit. --follow keeps going.
//  - Jetstream only keeps roughly 24 hours of replay, and deletions are ignored. For a durable
//    log, run with --state and --json and append the output to a file.
//  - Not caught: anything that only refers to you indirectly (e.g. by CID, or via a post
//    that merely sits in a thread of yours).
import fs from 'fs';
import { execFileSync } from 'child_process';

const APPVIEW = 'https://public.api.bsky.app';
// Public Jetstream instances; tried in turn when one drops.
const HOSTS = [
  'jetstream1.us-east.bsky.network',
  'jetstream2.us-east.bsky.network',
  'jetstream1.us-west.bsky.network',
  'jetstream2.us-west.bsky.network',
];

const argValue = (name) => process.argv.find((x) => x.startsWith(`--${name}=`))?.slice(name.length + 3);
const actor = argValue('actor') || 'mpadge.eu';
const asJson = process.argv.includes('--json');
const stateFile = argValue('state');
const follow = process.argv.includes('--follow');
const parseDuration = (s) => {
  const m = /^(\d+(?:\.\d+)?)([smhd])$/.exec(s);
  if (!m) throw new Error(`Cannot parse duration: ${s}`);
  return Number(m[1]) * { s: 1e3, m: 6e4, h: 36e5, d: 864e5 }[m[2]];
};
const duration = argValue('duration') ? parseDuration(argValue('duration')) : null;

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status} ${await res.text()}`);
  return res.json();
}

const profile = await getJson(`${APPVIEW}/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(actor)}`);
const me = profile.did;
// Strings that count as "pointing at you": your DID, plus (for Jetstream) your handle/domain, so
// that e.g. a Semble (network.cosmik.card) saving https://mpadge.eu/... is caught: such a card
// carries only the URL, never your DID. Override with --match=a,b (the DID is always included).
const needles = [me, ...(argValue('match') ?? profile.handle).split(',').filter(Boolean)];

// --- --unread: ask the AppView (authenticated), then exit -----------------------------------------
if (process.argv.includes('--unread')) {
  const PDS = process.env.ATPROTO_PDS || 'https://tngl.sh';
  const identifier = process.env.ATPROTO_IDENTIFIER || actor;
  let password = process.env.ATPROTO_APP_PASSWORD;
  if (!password) {
    try {
      password = execFileSync('pass', ['show', 'atproto/app-password'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n')[0].trim();
    } catch { /* handled below */ }
  }
  if (!password) throw new Error('Set ATPROTO_APP_PASSWORD or add atproto/app-password to pass');

  const call = async (method, path, { body, token, query } = {}) => {
    const res = await fetch(`${PDS}/xrpc/${path}${query ? `?${new URLSearchParams(query)}` : ''}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token && { authorization: `Bearer ${token}`, 'atproto-proxy': 'did:web:api.bsky.app#bsky_appview' }),
      },
      body: body && JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
    return res.json();
  };

  const { accessJwt: token, did } = await call('POST', 'com.atproto.server.createSession', { body: { identifier, password } });
  if (did !== me) console.error(`# note: logged in as ${did}, not ${me}`);
  const { count } = await call('GET', 'app.bsky.notification.getUnreadCount', { token });

  // Newest first; stop at the first notification that is already read.
  const unread = [];
  let cur = '', done = false;
  while (!done && unread.length < count + 100) {
    const r = await call('GET', 'app.bsky.notification.listNotifications', { token, query: { limit: '100', ...(cur && { cursor: cur }) } });
    for (const n of r.notifications) {
      if (n.isRead) { done = true; break; }
      unread.push(n);
    }
    cur = r.cursor;
    if (!cur) done = true;
  }

  console.error(`# ${count} unread (AppView getUnreadCount); ${unread.length} listed`);
  for (const n of unread) {
    const out = { time: n.indexedAt, reason: n.reason, handle: n.author.handle, did: n.author.did,
      uri: n.uri, subject: n.reasonSubject, text: n.record?.text,
      // likes/reposts: link to YOUR post that was liked; everything else: the notifying record
      url: httpsUrl(['like', 'repost'].includes(n.reason) && n.reasonSubject ? n.reasonSubject : n.uri, n.author.handle) };
    if (asJson) console.log(JSON.stringify(out));
    else console.log(`${out.time}  ${out.reason.padEnd(9)} ${out.handle}${out.text ? `\n    ${out.text.replace(/\s+/g, ' ')}` : ''}\n    ${out.url}`);
  }
  process.exit(0);
}

// --- starting cursor (microseconds since epoch) ---------------------------------------------
function parseSince(s) {
  const rel = /^(\d+(?:\.\d+)?)([smhd])$/.exec(s);
  if (rel) return Date.now() - Number(rel[1]) * { s: 1e3, m: 6e4, h: 36e5, d: 864e5 }[rel[2]];
  const t = Date.parse(s);
  if (Number.isNaN(t)) throw new Error(`Cannot parse --since=${s}`);
  return t;
}
let cursor = null; // time_us of the last event seen
if (stateFile && fs.existsSync(stateFile)) cursor = Number(fs.readFileSync(stateFile, 'utf8').trim()) || null;
if (argValue('since')) cursor = parseSince(argValue('since')) * 1000;
// Once-mode has to start somewhere in the past; follow mode may start live (no cursor).
if (!cursor && !follow) cursor = (Date.now() - 24 * 36e5) * 1000;
const replaying = cursor !== null;
const saveCursor = () => stateFile && cursor && fs.writeFileSync(stateFile, String(cursor));

// --- matching -------------------------------------------------------------------------------
// Walk a record; return the paths ("reply.parent.uri") of every string that contains our DID.
function findRefs(value, path = '', out = []) {
  if (typeof value === 'string') {
    if (needles.some((n) => value.includes(n))) out.push(path);
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => findRefs(v, `${path}[${i}]`, out));
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) findRefs(v, path ? `${path}.${k}` : k, out);
  }
  return out;
}

// Third-party lexicons: classify by the record type's last NSID segment, which is stable across
// network.cosmik.* (Semble), sh.tangled.* / org.tangled.* (Tangled), site.standard.* etc.
const GENERIC = { follow: 'follow', star: 'star', like: 'like', repost: 'repost', subscription: 'subscribe',
  card: 'saved-link', collectionLink: 'collected', comment: 'comment', issue: 'issue', pull: 'pull-request' };

function classify(collection, paths, onlyText) {
  const has = (re) => paths.some((p) => re.test(p));
  if (onlyText) return GENERIC[collection.split('.').pop()] || 'link';
  switch (collection) {
    case 'app.bsky.feed.like': return 'like';
    case 'app.bsky.feed.repost': return 'repost';
    case 'app.bsky.graph.follow': return 'follow';
    case 'app.bsky.feed.post':
      if (has(/^reply\./)) return 'reply';
      if (has(/^embed\./)) return 'quote';
      if (has(/^facets/)) return 'mention';
      return 'reference';
    case 'app.bsky.graph.listitem': return 'list-add';
    case 'app.bsky.graph.starterpack': return 'starterpack';
    default: return GENERIC[collection.split('.').pop()] || 'reference';
  }
}

// --- https links ----------------------------------------------------------------------------
// at:// URIs only open in atproto tools. Posts map to bsky.app; follows to the follower's profile;
// everything else (Semble, Tangled, ...) to the atproto.at record viewer, which works for any record.
function httpsUrl(uri, who) {
  const m = /^at:\/\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(uri || '');
  if (!m) return undefined;
  const [, repo, collection, rkey] = m;
  if (collection === 'app.bsky.feed.post') return `https://bsky.app/profile/${who || repo}/post/${rkey}`;
  if (collection === 'app.bsky.graph.follow') return `https://bsky.app/profile/${who || repo}`;
  return `https://atproto.at/uri/${uri}`;
}

// --- handle resolution (cached) -------------------------------------------------------------
const handles = new Map();
async function handleOf(did) {
  if (handles.has(did)) return handles.get(did);
  let h = did;
  try {
    const doc = await getJson(did.startsWith('did:web:')
      ? `https://${did.slice(8)}/.well-known/did.json` : `https://plc.directory/${did}`);
    h = doc.alsoKnownAs?.find((a) => a.startsWith('at://'))?.slice(5) || did;
  } catch { /* leave as DID */ }
  handles.set(did, h);
  return h;
}

// --- output ---------------------------------------------------------------------------------
async function report(ev) {
  const { did, time_us: t, commit: c } = ev;
  const paths = findRefs(c.record);
  // Only the site/handle matched, not the DID: someone linked to you without addressing you.
  const hasDid = JSON.stringify(c.record).includes(me);
  const kind = classify(c.collection, paths, !hasDid);
  const hit = {
    time: new Date(t / 1000).toISOString(),
    kind,
    handle: await handleOf(did),
    did,
    collection: c.collection,
    uri: `at://${did}/${c.collection}/${c.rkey}`,
    url: httpsUrl(`at://${did}/${c.collection}/${c.rkey}`, undefined),
    paths,
    text: c.record.text,
  };
  if (asJson) {
    console.log(JSON.stringify(hit));
  } else {
    console.log(`${hit.time}  ${kind.padEnd(9)} ${hit.handle}  ${hit.collection}${hit.text ? `\n    ${hit.text.replace(/\s+/g, ' ')}` : ''}\n    ${hit.url}`);
  }
}

// --- Jetstream connection -------------------------------------------------------------------
let hostIdx = 0, seen = 0, hits = 0;
const recent = new Set(); // dedupe across reconnects
const t0 = Date.now();
let queue = Promise.resolve(); // keeps reports in order and lets us wait for them before exiting
let caughtUp = false;

async function finish() {
  await queue;
  saveCursor();
  console.error(`# done: ${seen} events scanned, ${hits} notification${hits === 1 ? '' : 's'}`);
  process.exit(0);
}

function connect() {
  const host = HOSTS[hostIdx % HOSTS.length];
  const q = new URLSearchParams();
  q.append('requireHello', 'false');
  // Rewind 5s on reconnect so nothing in the gap is lost; duplicates are dropped below.
  if (cursor) q.append('cursor', String(Math.max(0, cursor - 5e6)));
  // NOTE: deliberately no wantedCollections / wantedDids: we want everything.
  const ws = new WebSocket(`wss://${host}/subscribe?${q}`);
  console.error(`# connecting to ${host}${cursor ? ` from ${new Date(cursor / 1000).toISOString()}` : ' (live)'}; watching ${profile.handle} (${me})`);

  ws.onmessage = async (m) => {
    let ev;
    try { ev = JSON.parse(m.data); } catch { return; }
    cursor = ev.time_us;
    seen++;
    if (!caughtUp && ev.time_us / 1000 > Date.now() - 10000) {
      caughtUp = true;
      if (replaying) console.error(`# caught up to live after ${((Date.now() - t0) / 1000).toFixed(0)}s (${seen} events scanned)`);
      if (!follow) return finish();
    }
    if (ev.kind !== 'commit' || ev.commit?.operation === 'delete' || ev.did === me || !ev.commit?.record) return;
    const raw = JSON.stringify(ev.commit.record);
    if (!needles.some((n) => raw.includes(n))) return; // cheap pre-filter
    const id = `${ev.did}/${ev.commit.collection}/${ev.commit.rkey}/${ev.commit.rev}`;
    if (recent.has(id)) return;
    recent.add(id);
    if (recent.size > 5000) recent.delete(recent.values().next().value);
    hits++;
    queue = queue.then(() => report(ev));
  };
  ws.onopen = () => console.error(`# connected to ${host}${replaying && !caughtUp ? ', replaying history' : ', live'}`);
  ws.onerror = () => {};
  ws.onclose = () => {
    saveCursor();
    hostIdx++;
    console.error(`# disconnected from ${host}; reconnecting in 2s`);
    setTimeout(connect, 2000);
  };
  return ws;
}

setInterval(saveCursor, 10000).unref();
setInterval(() => {
  const mins = ((Date.now() - t0) / 6e4).toFixed(1);
  console.error(`# ${mins} min: ${seen} events scanned, ${hits} notifications`);
}, 60000).unref();
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { saveCursor(); process.exit(0); });
if (duration) setTimeout(finish, duration);

connect();
