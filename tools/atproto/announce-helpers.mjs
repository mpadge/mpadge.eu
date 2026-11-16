// Helpers for announcing blog posts and notes on Bluesky (used by publish.mjs).
import fs from 'fs';

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
