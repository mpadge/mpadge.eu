// Publish site.standard.publication / site.standard.document records for this
// blog to the author's AT Protocol PDS, and record their AT-URIs in
// src/atproto.json (read by the build for verification links).
//
//   node tools/atproto/publish.mjs            # dry run: print records only
//   (PDS defaults to https://tngl.sh; override with ATPROTO_PDS)
//   ATPROTO_IDENTIFIER=mpadge.eu ATPROTO_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx \
//     node tools/atproto/publish.mjs --publish
//   ... --publish --announce=<slug>   # also create a PUBLIC Bluesky post for that blog
//                                     # post (asks for confirmation; skipped if the
//                                     # post already has a `bluesky:` link)
//
// Uses putRecord with deterministic rkeys (publication: "mpadge"; documents:
// post slug), so re-running is idempotent: it updates records in place.
import fs from 'fs';
import * as yaml from 'js-yaml';
import readline from 'readline/promises';
import { loadNotes } from '../notesPages.js';
import { addBlueskyField, recentUnannounced } from './announce-helpers.mjs';

const SITE = 'https://mpadge.eu';
const PUB_RKEY = 'mpadge';
const PUB = {
  $type: 'site.standard.publication',
  url: SITE,
  name: "Mark Padgham's curated opinions",
  description: 'Opinions on technology in the world, on open-source software, on cities, and sometimes on bicycles.',
};
// Separate publication for short notes (lives at https://mpadge.eu/notes).
const NOTES_RKEY = 'notes';
const NOTES_PUB = {
  $type: 'site.standard.publication',
  url: `${SITE}/notes`,
  name: 'Notes',
  description: 'Short notes.',
};
const PDS = process.env.ATPROTO_PDS || 'https://tngl.sh';
const doPublish = process.argv.includes('--publish');
const announceArg = process.argv.find((a) => a.startsWith('--announce='));
const announceSlug = announceArg ? announceArg.slice('--announce='.length) : '';

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
const { ATPROTO_IDENTIFIER: identifier, ATPROTO_APP_PASSWORD: password } = process.env;
if (doPublish) {
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
const notesUri = await put('site.standard.publication', NOTES_RKEY, NOTES_PUB);
const documents = {};
for (const post of posts) {
  const { slug, rec } = documentRecord(post, pubUri);
  documents[`${slug}.html`] = await put('site.standard.document', slug, rec);
}

// Notes: documents of the notes publication. rkeys are prefixed so they can
// never collide with blog post slugs in the same collection.
const noteDocuments = {};
for (const n of loadNotes()) {
  const rec = {
    $type: 'site.standard.document',
    site: notesUri,
    path: `/notes/${n.slug}.html`,
    title: n.title,
    publishedAt: new Date(`${n.date}T00:00:00Z`).toISOString(),
  };
  if (n.description) rec.description = n.description;
  if (n.tags) rec.tags = n.tags.split(',').map((t) => t.trim()).filter(Boolean);
  noteDocuments[`${n.slug}.html`] = await put('site.standard.document', `note-${n.slug}`, rec);
}

if (doPublish) {
  fs.writeFileSync('src/atproto.json', JSON.stringify({ publication: pubUri, publications: { notes: notesUri }, documents, noteDocuments }, null, 2) + '\n');
  console.log('Wrote src/atproto.json');
  await announceStep();
} else {
  console.log('\nDry run only. Re-run with --publish to create the records.');
}

// ---- Bluesky announcements (public posts that serve as comment threads) ----

async function confirm(question) {
  if (!process.stdin.isTTY) throw new Error('Announcing needs an interactive terminal for confirmation');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(question);
  rl.close();
  return answer.trim().toLowerCase() === 'y';
}

async function announceStep() {
  if (!announceSlug) {
    const pending = recentUnannounced(posts, (p) => new Date(isoDate(p)));
    console.log('\nNo Bluesky post created: this run only published the atproto records.');
    if (pending.length) {
      console.log('Recent posts with no `bluesky:` link (no Bluesky comments yet):');
      for (const p of pending) console.log(`  ${p.link.replace(/\.html$/, '')}  (${p.created})`);
      console.log('To announce one on Bluesky: make publish POST=<slug>');
      console.log('That creates a PUBLIC post on your account, asks for confirmation, and is skipped for posts that already have a link.');
    } else {
      console.log('All posts from the last 30 days already have a `bluesky:` link; nothing to announce.');
    }
    return;
  }

  const post = posts.find((p) => p.link === `${announceSlug}.html`);
  if (!post) throw new Error(`No blog post with slug "${announceSlug}"`);
  if (post.bluesky) {
    console.log(`\n"${announceSlug}" already has a Bluesky post (${post.bluesky}); nothing to announce.`);
    return;
  }
  const { rec } = documentRecord(post, pubUri);
  const uri = `${SITE}/blog/${post.link}`;
  const description = rec.description.length > 280 ? `${rec.description.slice(0, 277)}...` : rec.description;
  console.log(`\nAbout to create a PUBLIC Bluesky post as ${identifier}:\n  text: ${rec.title}\n  link card: ${uri}`);
  if (!(await confirm('Post it? [y/N] '))) { console.log('Not announced.'); return; }

  const r = await xrpc('POST', 'com.atproto.repo.createRecord', {
    repo: did,
    collection: 'app.bsky.feed.post',
    record: {
      $type: 'app.bsky.feed.post',
      text: rec.title,
      langs: ['en'],
      createdAt: new Date().toISOString(),
      embed: { $type: 'app.bsky.embed.external', external: { uri, title: rec.title, description } },
    },
  }, token);
  const url = `https://bsky.app/profile/${identifier}/post/${r.uri.split('/').pop()}`;
  const mdFile = addBlueskyField(announceSlug, post.link, url);
  console.log(`Posted ${url}\nAdded bluesky: field to ${mdFile} and src/data/blog.yml; commit both.`);
}
