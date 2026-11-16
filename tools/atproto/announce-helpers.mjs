// Helpers for announcing blog posts on Bluesky (used by publish.mjs).
import fs from 'fs';

// Record the Bluesky post URL of a blog post in the places the site reads it:
//   - the post's markdown front matter (source of truth: tools/blog/update_main.R
//     regenerates blog.yml from it), after the `mastodon:` line if present
//   - src/data/blog.yml, so no `make update` is needed before building
export function addBlueskyField(slug, link, url, { blogYml = 'src/data/blog.yml', blogDir = 'src/pages/blog' } = {}) {
  const re = new RegExp(`^\\d{4}-\\d{2}-\\d{2}-${slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.md$`);
  const mdName = fs.readdirSync(blogDir).find((f) => re.test(f));
  if (!mdName) throw new Error(`No markdown source for "${slug}" in ${blogDir}`);
  const mdFile = `${blogDir}/${mdName}`;

  const md = fs.readFileSync(mdFile, 'utf8').split('\n');
  const open = md.indexOf('---');
  const close = md.indexOf('---', open + 1);
  if (open !== 0 || close < 0) throw new Error(`No front matter in ${mdFile}`);
  if (md.slice(0, close).some((l) => /^bluesky:/.test(l))) throw new Error(`${mdFile} already has a bluesky: field`);
  const m = md.findIndex((l, i) => i < close && /^mastodon:/.test(l));
  md.splice(m >= 0 ? m + 1 : close, 0, `bluesky: ${url}`);
  fs.writeFileSync(mdFile, md.join('\n'));

  const yml = fs.readFileSync(blogYml, 'utf8').split('\n');
  const i = yml.findIndex((l) => l === `    link: ${link}`);
  if (i < 0) throw new Error(`No entry with link: ${link} in ${blogYml}`);
  yml.splice(i, 0, `    bluesky: ${url}`);
  fs.writeFileSync(blogYml, yml.join('\n'));
  return mdFile;
}

// Posts without a `bluesky:` link, newest first, created within the last `days`.
// `parseDate` turns the created string ("10 Nov 26") into a Date.
export function recentUnannounced(posts, parseDate, days = 30, now = Date.now()) {
  return posts
    .filter((p) => !p.bluesky && (now - parseDate(p.created).getTime()) / 864e5 <= days)
    .sort((a, b) => parseDate(b.created) - parseDate(a.created));
}
