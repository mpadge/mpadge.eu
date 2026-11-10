// Publish site.standard.publication / site.standard.document records for this
// blog to the author's AT Protocol PDS, and record their AT-URIs in
// src/atproto.json (read by the build for verification links).
//
//   node tools/atproto/publish.mjs            # dry run: print records only
//   (PDS defaults to https://tngl.sh; override with ATPROTO_PDS)
//   ATPROTO_IDENTIFIER=mpadge.eu ATPROTO_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx \
//     node tools/atproto/publish.mjs --publish
//
// Uses putRecord with deterministic rkeys (publication: "mpadge"; documents:
// post slug), so re-running is idempotent: it updates records in place.
import fs from 'fs';
import * as yaml from 'js-yaml';

const SITE = 'https://mpadge.eu';
const PUB_RKEY = 'mpadge';
const PUB = {
  $type: 'site.standard.publication',
  url: SITE,
  name: "Mark Padgham's curated opinions",
  description: 'Opinions on technology in the world, on open-source software, on cities, and sometimes on bicycles.',
};
const PDS = process.env.ATPROTO_PDS || 'https://tngl.sh';
const doPublish = process.argv.includes('--publish');

const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
function isoDate(s) { // "10 Nov 26" or "10 Nov 2026"
  const m = /^(\d{1,2}) (\w{3})\w* (\d{2,4})$/.exec(String(s).trim());
  if (!m) throw new Error(`Unparseable date: ${s}`);
  const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
  return new Date(Date.UTC(y, MONTHS[m[2]], +m[1])).toISOString();
}
const strip = (h) => String(h).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

const posts = yaml.load(fs.readFileSync('src/data/blog.yml', 'utf8')).filter((e) => e && e.link);

function documentRecord(post, pubUri) {
  const slug = post.link.replace(/\.html$/, '');
  const rec = {
    $type: 'site.standard.document',
    site: pubUri,
    path: `/blog/${post.link}`,
    title: String(post.title).replace(/^"|"$/g, ''),
    description: strip(post.description).slice(0, 3000),
    publishedAt: isoDate(post.created),
  };
  if (post.updated) rec.updatedAt = isoDate(post.updated);
  if (post.tags) rec.tags = String(post.tags).split(',').map((t) => t.trim()).filter(Boolean);
  return { slug, rec };
}

async function xrpc(method, path, body, token) {
  const res = await fetch(`${PDS}/xrpc/${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) },
    body: body && JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

let did = 'did:plc:DRYRUN';
let token;
if (doPublish) {
  const { ATPROTO_IDENTIFIER: identifier, ATPROTO_APP_PASSWORD: password } = process.env;
  if (!identifier || !password) throw new Error('Set ATPROTO_IDENTIFIER and ATPROTO_APP_PASSWORD');
  const s = await xrpc('POST', 'com.atproto.server.createSession', { identifier, password });
  did = s.did; token = s.accessJwt;
}

async function put(collection, rkey, record) {
  const uri = `at://${did}/${collection}/${rkey}`;
  if (!doPublish) { console.log(uri, JSON.stringify(record, null, 2)); return uri; }
  const r = await xrpc('POST', 'com.atproto.repo.putRecord',
    { repo: did, collection, rkey, record, validate: false }, token);
  console.log('put', r.uri);
  return r.uri;
}

const pubUri = await put('site.standard.publication', PUB_RKEY, PUB);
const documents = {};
for (const post of posts) {
  const { slug, rec } = documentRecord(post, pubUri);
  documents[`${slug}.html`] = await put('site.standard.document', slug, rec);
}

if (doPublish) {
  fs.writeFileSync('src/atproto.json', JSON.stringify({ publication: pubUri, documents }, null, 2) + '\n');
  console.log('Wrote src/atproto.json');
} else {
  console.log('\nDry run only. Re-run with --publish to create the records.');
}
