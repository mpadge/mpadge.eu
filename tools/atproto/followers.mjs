// List who follows an account on Bluesky, with the time each follow was created.
// No login needed: everything read here is public.
//
//   node tools/atproto/followers.mjs                  # actor defaults to mpadge.eu
//   node tools/atproto/followers.mjs --json           # JSON instead of a table
//   node tools/atproto/followers.mjs --actor=other.handle
//
// Where the data comes from:
//  - Handles / names: the Bluesky AppView (app.bsky.graph.getFollowers).
//  - Follow timestamps: a follow is a record in the *follower's* repo, not in yours, so
//    the AppView does not give its time. The follow records pointing at you are found
//    with Constellation (a public backlink index), and each record's own `createdAt` is
//    read from the follower's PDS. If that fails, the time is decoded from the record
//    key (a TID encodes a microsecond timestamp), marked "tid" in the `source` column.
import { publicAgent, agentFor, paginate, pdsOf } from './agent.mjs';

const CONSTELLATION = 'https://constellation.microcosm.blue';
const argValue = (name) => process.argv.find((x) => x.startsWith(`--${name}=`))?.slice(name.length + 3);
const actor = argValue('actor') || 'mpadge.eu';
const asJson = process.argv.includes('--json');

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status} ${await res.text()}`);
  return res.json();
}

// TID record key -> ISO time (base32-sortable, 13 chars, 53 bits of microseconds)
function tidToIso(tid) {
  const alphabet = '234567abcdefghijklmnopqrstuvwxyz';
  let n = 0n;
  for (const c of tid) n = (n << 5n) | BigInt(alphabet.indexOf(c));
  return new Date(Number((n >> 10n) / 1000n)).toISOString();
}

const agent = publicAgent();
const { data: profile } = await agent.app.bsky.actor.getProfile({ actor });

const followers = await paginate(
  async (cursor) => (await agent.app.bsky.graph.getFollowers({ actor: profile.did, limit: 100, cursor })).data,
  (r) => r.followers);

// Constellation is not atproto XRPC, so it is the one call outside the SDK.
const records = await paginate(
  (c) => getJson(`${CONSTELLATION}/links?target=${profile.did}&collection=app.bsky.graph.follow&path=.subject&limit=100${c ? `&cursor=${c}` : ''}`),
  (r) => r.linking_records);
const rkeyByDid = new Map(records.map((r) => [r.did, r.rkey]));

const rows = [];
for (const f of followers) {
  const rkey = rkeyByDid.get(f.did);
  let followedAt = '', source = '';
  if (rkey) {
    try {
      const pds = await pdsOf(f.did);
      const { data } = await agentFor(pds).com.atproto.repo.getRecord({ repo: f.did, collection: 'app.bsky.graph.follow', rkey });
      followedAt = data.value.createdAt;
      if (!followedAt) throw new Error('no createdAt');
      source = 'record';
    } catch {
      followedAt = tidToIso(rkey);
      source = 'tid';
    }
  }
  rows.push({ followedAt, handle: f.handle, did: f.did, displayName: f.displayName || '', source });
}
rows.sort((a, b) => (a.followedAt || '￿').localeCompare(b.followedAt || '￿'));

if (asJson) {
  console.log(JSON.stringify(rows, null, 2));
} else {
  console.log(`${rows.length} followers of ${profile.handle} (${profile.did}); AppView reports ${profile.followersCount}\n`);
  for (const r of rows) {
    console.log([r.followedAt || '(unknown)', r.source || '-', r.handle, r.displayName].join('\t'));
  }
}
