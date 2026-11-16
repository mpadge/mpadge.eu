// Helpers for announcing blog posts and notes on Bluesky (used by publish.mjs).
import fs from 'fs';

const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
export function isoDate(s) { // "10 Nov 26" or "10 Nov 2026"
  const m = /^(\d{1,2}) (\w{3})\w* (\d{2,4})$/.exec(String(s).trim());
  if (!m) throw new Error(`Unparseable date: ${s}`);
  const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
  return new Date(Date.UTC(y, MONTHS[m[2]], +m[1])).toISOString();
}

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function findMarkdown(dir, slug) {
  const re = new RegExp(`^\\d{4}-\\d{2}-\\d{2}-${escRe(slug)}\\.md$`);
  const name = fs.readdirSync(dir).find((f) => re.test(f));
  if (!name) throw new Error(`No markdown source for "${slug}" in ${dir}`);
  return `${dir}/${name}`;
}

// Insert `bluesky: <url>` into the front matter, after the `mastodon:` line if
// there is one, else at the end of the front matter.
function insertBlueskyField(mdFile, url) {
  const md = fs.readFileSync(mdFile, 'utf8').split('\n');
  const open = md.indexOf('---');
  const close = md.indexOf('---', open + 1);
  if (open !== 0 || close < 0) throw new Error(`No front matter in ${mdFile}`);
  if (md.slice(0, close).some((l) => /^bluesky:/.test(l))) throw new Error(`${mdFile} already has a bluesky: field`);
  const m = md.findIndex((l, i) => i < close && /^mastodon:/.test(l));
  md.splice(m >= 0 ? m + 1 : close, 0, `bluesky: ${url}`);
  fs.writeFileSync(mdFile, md.join('\n'));
}

// Blog post: record the Bluesky post URL in the places the site reads it:
//   - the post's markdown front matter (source of truth: tools/blog/update_main.R
//     regenerates blog.yml from it)
//   - src/data/blog.yml, so no `make update` is needed before building
export function addBlueskyField(slug, link, url, { blogYml = 'src/data/blog.yml', blogDir = 'src/pages/blog' } = {}) {
  const mdFile = findMarkdown(blogDir, slug);
  insertBlueskyField(mdFile, url);

  const yml = fs.readFileSync(blogYml, 'utf8').split('\n');
  const i = yml.findIndex((l) => l === `    link: ${link}`);
  if (i < 0) throw new Error(`No entry with link: ${link} in ${blogYml}`);
  yml.splice(i, 0, `    bluesky: ${url}`);
  fs.writeFileSync(blogYml, yml.join('\n'));
  return mdFile;
}

// Note: the markdown front matter is the only place notes keep this.
export function addBlueskyFieldToNote(slug, url, { notesDir = 'src/pages/notes' } = {}) {
  const mdFile = findMarkdown(notesDir, slug);
  insertBlueskyField(mdFile, url);
  return mdFile;
}

// Items (posts or notes) without a `bluesky` link, newest first, dated within
// the last `days`. `dateOf` turns an item into a Date.
export function recentUnannounced(items, dateOf, days = 30, now = Date.now()) {
  return items
    .filter((x) => !x.bluesky && (now - dateOf(x).getTime()) / 864e5 <= days)
    .sort((a, b) => dateOf(b) - dateOf(a));
}

// Normalise a link to one of this site's pages for comparison: "/blog/slug"
// for https://mpadge.eu/blog/slug.html, .../slug, .../slug/?x=y#z; '' for any
// other site.
export function pageKey(u) {
  try {
    const x = new URL(u);
    if (!/^(www\.)?mpadge\.eu$/.test(x.hostname)) return '';
    return x.pathname.replace(/\/+$/, '').replace(/\.html$/, '');
  } catch { return ''; }
}

// Links contained in a Bluesky post record: link-card embeds (also inside a
// record-with-media embed) and link facets.
function recordLinks(record) {
  const links = [];
  const e = record.embed || {};
  if (e.external?.uri) links.push(e.external.uri);
  if (e.media?.external?.uri) links.push(e.media.external.uri);
  for (const f of record.facets || []) {
    for (const ft of f.features || []) if (ft.uri) links.push(ft.uri);
  }
  return links;
}

// Find the author's own Bluesky posts that link to site pages.
//   feed:       items from app.bsky.feed.getAuthorFeed
//   candidates: [{ id, url }] pages to look for
//   did:        only posts by this author count (reposts are ignored)
// Returns Map id -> { url, createdAt, count }: the earliest matching post (the
// original announcement) and how many posts matched.
export function findAnnouncements(feed, candidates, { did, handle }) {
  const wanted = new Map(candidates.map((c) => [pageKey(c.url), c.id]));
  const found = new Map();
  for (const item of feed) {
    const post = item.post;
    if (item.reason || !post || post.author?.did !== did) continue;
    const record = post.record || {};
    for (const link of new Set(recordLinks(record))) {
      const id = wanted.get(pageKey(link));
      if (!id) continue;
      const createdAt = record.createdAt || post.indexedAt || '';
      const url = `https://bsky.app/profile/${handle}/post/${post.uri.split('/').pop()}`;
      const prev = found.get(id);
      found.set(id, !prev ? { url, createdAt, count: 1 }
        : { ...(createdAt < prev.createdAt ? { url, createdAt } : prev), count: prev.count + 1 });
    }
  }
  return found;
}
