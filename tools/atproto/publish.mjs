// Publish site.standard.publication / site.standard.document records for this
// blog to the author's AT Protocol PDS, and record their AT-URIs in
// src/atproto.json (read by the build for verification links).
//
//   node tools/atproto/publish.mjs            # dry run: print records only
//   (PDS defaults to https://tngl.sh; override with ATPROTO_PDS)
//   ATPROTO_IDENTIFIER=mpadge.eu ATPROTO_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx \
//     node tools/atproto/publish.mjs --publish
//   ... --publish --announce=<slug>        # also create a PUBLIC Bluesky post for that
//   ... --publish --announce-note=<slug>   # blog post / note (asks for confirmation;
//                                          # skipped if it already has a `bluesky:` link)
//   ... --text='...' (or env ANNOUNCE_TEXT)  # post this text instead of "title + description"
//                                          # (with exactly one of the two --announce options)
// The post text is "<title>\n\n<description>" and must fit Bluesky's 300-character
// limit; this is checked before anything is written to the PDS.
//
// Also files a network.cosmik.card per post/note (Semble) in the matching collection.
//
// Uses putRecord with deterministic rkeys (publication: "mpadge"; documents:
// post slug), so re-running is idempotent: it updates records in place.
import fs from 'fs';
import * as yaml from 'js-yaml';
import readline from 'readline/promises';
import { loadNotes } from '../site/notesPages.js';
import { addBlueskyField, addBlueskyFieldToNote, recentUnannounced, isoDate } from './announce-helpers.mjs';

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
const argValue = (name) => {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : '';
};
const announceSlug = argValue('announce');      // blog post slug
const announceNote = argValue('announce-note'); // note slug
const textOverride = argValue('text') || process.env.ANNOUNCE_TEXT || ''; // ANNOUNCE_TEXT is set by `make publish TEXT=...`

const strip = (h) => String(h).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

const posts = yaml.load(fs.readFileSync('src/data/blog.yml', 'utf8')).filter((e) => e && e.link);
const notes = loadNotes();

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

// ---- Bluesky post text: validated up front, before anything is written ----
const POST_LIMIT = 300; // graphemes
const graphemes = (str) => [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(str)].length;

function announcementText(what, title, description, override) {
  const text = override || (description ? `${title}\n\n${description}` : title);
  const n = graphemes(text);
  if (n > POST_LIMIT) {
    throw new Error(`Bluesky post for ${what} would be ${n} characters, over the ${POST_LIMIT} limit ` +
      (override ? '(the TEXT you gave).' : `(title ${graphemes(title)} + description ${graphemes(description)} + 2 for the blank line). `) +
      (override ? '' : 'Shorten the description, or give your own text with TEXT="..." (make publish ... TEXT="...").'));
  }
  return text;
}

// One plan per requested announcement; announceStep() carries them out.
const plans = [];
if (textOverride && !(!announceSlug !== !announceNote)) {
  throw new Error('TEXT needs exactly one of POST=<slug> or NOTE=<slug>');
}
if (announceSlug) {
  const post = posts.find((p) => p.link === `${announceSlug}.html`);
  if (!post) throw new Error(`No blog post with slug "${announceSlug}"`);
  const { rec } = documentRecord(post, '');
  const what = `blog post "${announceSlug}"`;
  plans.push({
    what, existing: post.bluesky, title: rec.title, description: rec.description,
    text: post.bluesky ? '' : announcementText(what, rec.title, rec.description, textOverride),
    uri: `${SITE}/blog/${post.link}`,
    save: (url) => `${addBlueskyField(announceSlug, post.link, url)} and src/data/blog.yml`,
  });
}
if (announceNote) {
  const note = notes.find((n) => n.slug === announceNote);
  if (!note) throw new Error(`No note with slug "${announceNote}"`);
  const what = `note "${announceNote}"`;
  plans.push({
    what, existing: note.bluesky, title: note.title, description: note.description,
    text: note.bluesky ? '' : announcementText(what, note.title, note.description, textOverride),
    uri: `${SITE}/notes/${note.slug}.html`,
    save: (url) => addBlueskyFieldToNote(announceNote, url),
  });
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
for (const n of notes) {
  const rec = {
    $type: 'site.standard.document',
    site: notesUri,
    // Relative to the notes publication url (https://mpadge.eu/notes), so not
    // "/notes/..." (readers join publication url + path).
    path: `/${n.slug}.html`,
    title: n.title,
    publishedAt: new Date(`${n.date}T00:00:00Z`).toISOString(),
  };
  if (n.description) rec.description = n.description;
  if (n.tags) rec.tags = n.tags.split(',').map((t) => t.trim()).filter(Boolean);
  noteDocuments[`${n.slug}.html`] = await put('site.standard.document', `note-${n.slug}`, rec);
}

// ---- Semble (network.cosmik) cards, filed in the "mpadge blog entries" / "mpadge note entries"
// collections (created by hand in Semble; looked up by name). A URL that already has a
// card (e.g. saved by hand) is reused, never duplicated or modified, and an existing
// collection link is left alone, so re-running is idempotent.
const COSMIK = { card: 'network.cosmik.card', collection: 'network.cosmik.collection', link: 'network.cosmik.collectionLink' };
const BLOG_COLLECTION = 'mpadge blog entries';
const NOTE_COLLECTION = 'mpadge note entries';
const readRepo = doPublish ? did : (identifier || 'mpadge.eu');

async function listAll(collection) {
  const out = [];
  let cursor = '';
  do {
    const q = new URLSearchParams({ repo: readRepo, collection, limit: '100', ...(cursor && { cursor }) });
    const r = await xrpc('GET', `com.atproto.repo.listRecords?${q}`);
    out.push(...r.records);
    cursor = r.cursor;
  } while (cursor);
  return out;
}

async function cosmikStep() {
  const [cards, collections, links] = await Promise.all([COSMIK.card, COSMIK.collection, COSMIK.link].map(listAll));
  const collectionByName = (name) => {
    const c = collections.find((x) => x.value.name === name);
    if (!c) throw new Error(`No Semble collection named "${name}" in ${readRepo}'s repo`);
    return c;
  };
  const blogColl = collectionByName(BLOG_COLLECTION);
  const noteColl = collectionByName(NOTE_COLLECTION);
  const cardByUrl = new Map(cards.filter((c) => c.value.content?.url).map((c) => [c.value.content.url, c]));
  const linked = new Set(links.map((l) => `${l.value.collection?.uri}|${l.value.card?.uri}`));

  const items = [
    ...posts.map((p) => {
      const { slug, rec } = documentRecord(p, '');
      return { key: `blog-${slug}`, url: `${SITE}/blog/${p.link}`, title: rec.title, description: rec.description,
        date: rec.publishedAt, coll: blogColl };
    }),
    ...notes.map((n) => ({ key: `note-${n.slug}`, url: `${SITE}/notes/${n.slug}.html`, title: n.title,
      description: n.description, date: new Date(`${n.date}T00:00:00Z`).toISOString(), coll: noteColl })),
  ];

  for (const it of items) {
    let card = cardByUrl.get(it.url);
    if (!card) {
      const metadata = { $type: 'network.cosmik.card#urlMetadata', type: 'article', title: it.title,
        siteName: 'mpadge.eu', publishedDate: it.date };
      if (it.description) metadata.description = it.description.slice(0, 1000);
      const value = { $type: COSMIK.card, type: 'URL', createdAt: new Date().toISOString(),
        content: { $type: 'network.cosmik.card#urlContent', url: it.url, metadata } };
      const uri = await put(COSMIK.card, it.key, value);
      card = { uri, cid: doPublish ? (await xrpc('GET', `com.atproto.repo.getRecord?${new URLSearchParams({ repo: did, collection: COSMIK.card, rkey: it.key })}`)).cid : 'DRYRUN' };
    }
    if (linked.has(`${it.coll.uri}|${card.uri}`)) continue;
    const now = new Date().toISOString();
    await put(COSMIK.link, it.key, {
      $type: COSMIK.link,
      card: { uri: card.uri, cid: card.cid },
      collection: { uri: it.coll.uri, cid: it.coll.cid },
      addedBy: did, addedAt: now, createdAt: now,
    });
  }
}
await cosmikStep();

if (doPublish) {
  fs.writeFileSync('src/atproto.json', JSON.stringify({ publication: pubUri, publications: { notes: notesUri }, documents, noteDocuments }, null, 2) + '\n');
  console.log('Wrote src/atproto.json');
  await announceStep();
} else {
  console.log('\nDry run only. Re-run with --publish to create the records.');
  for (const plan of plans) {
    console.log(plan.existing ? `\n${plan.what} already has a Bluesky post; would not announce.`
      : `\nWould offer to post for ${plan.what}:\n---\n${plan.text}\n---\n  (${graphemes(plan.text)}/${POST_LIMIT} characters; link card: ${plan.uri})`);
  }
}

// ---- Bluesky announcements (public posts that serve as comment threads) ----

async function confirm(question) {
  if (!process.stdin.isTTY) throw new Error('Announcing needs an interactive terminal for confirmation');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(question);
  rl.close();
  return answer.trim().toLowerCase() === 'y';
}

// Create a Bluesky post (text validated earlier, plus a link card) and save its URL via save().
async function announceOne({ what, existing, title, description, text, uri, save }) {
  if (existing) {
    console.log(`\n${what} already has a Bluesky post (${existing}); nothing to announce.`);
    return;
  }
  const desc = description.length > 280 ? `${description.slice(0, 277)}...` : description;
  console.log(`\nAbout to create a PUBLIC Bluesky post as ${identifier} for ${what}:\n---\n${text}\n---\n  link card: ${uri}`);
  if (!(await confirm('Post it? [y/N] '))) { console.log('Not announced.'); return; }

  const r = await xrpc('POST', 'com.atproto.repo.createRecord', {
    repo: did,
    collection: 'app.bsky.feed.post',
    record: {
      $type: 'app.bsky.feed.post',
      text,
      langs: ['en'],
      createdAt: new Date().toISOString(),
      embed: { $type: 'app.bsky.embed.external', external: { uri, title, description: desc } },
    },
  }, token);
  const url = `https://bsky.app/profile/${identifier}/post/${r.uri.split('/').pop()}`;
  console.log(`Posted ${url}`);
  console.log(`Added bluesky: field to ${save(url)}; commit it.`);
}

async function announceStep() {
  if (!announceSlug && !announceNote) {
    const pendingPosts = recentUnannounced(posts, (p) => new Date(isoDate(p.created)));
    const pendingNotes = recentUnannounced(notes, (n) => new Date(`${n.date}T00:00:00Z`));
    console.log('\nNo Bluesky post created: this run only published the atproto records.');
    if (pendingPosts.length || pendingNotes.length) {
      console.log('Recent items with no `bluesky:` link (no Bluesky comments yet):');
      for (const p of pendingPosts) console.log(`  post ${p.link.replace(/\.html$/, '')}  (${p.created})`);
      for (const n of pendingNotes) console.log(`  note ${n.slug}  (${n.date})`);
      console.log('To announce on Bluesky: make publish POST=<post slug>   or   make publish NOTE=<note slug>');
      console.log('That creates a PUBLIC post on your account, asks for confirmation, and is skipped for items that already have a link.');
    } else {
      console.log('Everything from the last 30 days already has a `bluesky:` link; nothing to announce.');
    }
    return;
  }

  for (const plan of plans) await announceOne(plan);
}
