// Link Bluesky posts you made by hand (not via `make publish POST=...`) to the
// site, by filling in `bluesky:` in the post/note front matter (and blog.yml),
// which is what drives the comments section.
//
//   node tools/atproto/link-bluesky.mjs
//       Look through your recent public Bluesky posts for ones linking to a blog
//       post or note that has no `bluesky:` yet, and record them. Read-only on
//       the network (public API, no login).
//   node tools/atproto/link-bluesky.mjs --post=<slug> --url=<bsky.app post URL>
//   node tools/atproto/link-bluesky.mjs --note=<slug> --url=<bsky.app post URL>
//       Record a specific post explicitly.
import fs from 'fs';
import * as yaml from 'js-yaml';
import { loadNotes } from '../site/notesPages.js';
import { publicAgent, paginate, describeError } from './agent.mjs';
import { addBlueskyField, addBlueskyFieldToNote, findAnnouncements, recentUnannounced, isoDate } from './announce-helpers.mjs';

const SITE = 'https://mpadge.eu';
const HANDLE = 'mpadge.eu';
const MAX_PAGES = 5; // x 100 posts

const argValue = (name) => {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : '';
};
const posts = yaml.load(fs.readFileSync('src/data/blog.yml', 'utf8')).filter((e) => e && e.link);
const notes = loadNotes();

const linkPost = (post, url) => addBlueskyField(post.link.replace(/\.html$/, ''), post.link, url);
const linkNote = (note, url) => addBlueskyFieldToNote(note.slug, url);

// ---- explicit mode ---------------------------------------------------------
const postSlug = argValue('post');
const noteSlug = argValue('note');
const url = argValue('url');
if (postSlug || noteSlug || url) {
  if (!url || (!postSlug && !noteSlug) || (postSlug && noteSlug)) {
    throw new Error('Explicit mode needs --url=<bsky.app post URL> and exactly one of --post=<slug> or --note=<slug>');
  }
  if (!/^https:\/\/bsky\.app\/profile\/[^/]+\/post\/[A-Za-z0-9]+$/.test(url)) {
    throw new Error(`Not a bsky.app post URL: ${url}`);
  }
  const item = postSlug ? posts.find((p) => p.link === `${postSlug}.html`) : notes.find((n) => n.slug === noteSlug);
  if (!item) throw new Error(`No ${postSlug ? 'blog post' : 'note'} with slug "${postSlug || noteSlug}"`);
  if (item.bluesky) {
    console.log(`"${postSlug || noteSlug}" already has a Bluesky link (${item.bluesky}); edit it by hand to change it.`);
  } else {
    const file = postSlug ? linkPost(item, url) : linkNote(item, url);
    console.log(`✔ Linked ${url}\n  added bluesky: to ${file}${postSlug ? ' and src/data/blog.yml' : ''}`);
  }
  process.exit(0);
}

// ---- discovery mode --------------------------------------------------------
const missingPosts = posts.filter((p) => !p.bluesky);
const missingNotes = notes.filter((n) => !n.bluesky);
if (!missingPosts.length && !missingNotes.length) {
  console.log('Every blog post and note already has a `bluesky:` link; nothing to do.');
  process.exit(0);
}

const agent = publicAgent();
let did, feed;
try {
  ({ data: { did } } = await agent.com.atproto.identity.resolveHandle({ handle: HANDLE }));
  feed = await paginate(
    async (cursor) => (await agent.app.bsky.feed.getAuthorFeed({ actor: did, filter: 'posts_no_replies', limit: 100, cursor })).data,
    (page) => page.feed, { maxPages: MAX_PAGES });
} catch (e) {
  throw new Error(`Bluesky request failed: ${describeError(e)}`);
}
console.log(`Checked ${feed.length} recent Bluesky posts by ${HANDLE}.`);

const candidates = [
  ...missingPosts.map((p) => ({ id: `post:${p.link}`, url: `${SITE}/blog/${p.link}` })),
  ...missingNotes.map((n) => ({ id: `note:${n.slug}`, url: `${SITE}/notes/${n.slug}.html` })),
];
const found = findAnnouncements(feed, candidates, { did, handle: HANDLE });

let linked = 0;
for (const p of missingPosts) {
  const f = found.get(`post:${p.link}`);
  if (!f) continue;
  linkPost(p, f.url); linked++;
  console.log(`✔ post ${p.link.replace(/\.html$/, '')} -> ${f.url}${f.count > 1 ? `  (${f.count} posts link to it; used the earliest)` : ''}`);
}
for (const n of missingNotes) {
  const f = found.get(`note:${n.slug}`);
  if (!f) continue;
  linkNote(n, f.url); linked++;
  console.log(`✔ note ${n.slug} -> ${f.url}${f.count > 1 ? `  (${f.count} posts link to it; used the earliest)` : ''}`);
}

// Only mention recent items with no post found; older posts never had one.
const notFound = [
  ...recentUnannounced(missingPosts.filter((p) => !found.has(`post:${p.link}`)), (p) => new Date(isoDate(p.created)))
    .map((p) => `post ${p.link.replace(/\.html$/, '')}`),
  ...recentUnannounced(missingNotes.filter((n) => !found.has(`note:${n.slug}`)), (n) => new Date(`${n.date}T00:00:00Z`))
    .map((n) => `note ${n.slug}`),
];
for (const x of notFound) console.log(`- no Bluesky post found linking to ${x}`);
if (notFound.length) console.log('  (it must contain a link to the page, e.g. as a link card; or use make bluesky POST=<slug> BSKY=<post URL>)');
console.log(linked ? `\nLinked ${linked}. Commit the changed files.` : '\nNothing linked.');
