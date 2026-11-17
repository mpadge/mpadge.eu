// Offline tests for the pure helpers in tools/atproto (no network).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isoDate, pageKey, recentUnannounced, findAnnouncements, addBlueskyField, addBlueskyFieldToNote } from '../../tools/atproto/announce-helpers.mjs';
import { paginate, describeError } from '../../tools/atproto/agent.mjs';
import { printNotification } from '../../tools/atproto/notifications-common.mjs';

test('isoDate parses short and long dates and rejects junk', () => {
  assert.equal(isoDate('10 Nov 26'), '2026-11-10T00:00:00.000Z');
  assert.equal(isoDate('7 May 2019'), '2019-05-07T00:00:00.000Z');
  assert.throws(() => isoDate('yesterday'), /Unparseable/);
});

test('pageKey normalises links to this site only', () => {
  assert.equal(pageKey('https://mpadge.eu/blog/x.html'), '/blog/x');
  assert.equal(pageKey('https://www.mpadge.eu/blog/x/?a=1#b'), '/blog/x');
  assert.equal(pageKey('https://example.com/blog/x.html'), '');
  assert.equal(pageKey('not a url'), '');
});

test('recentUnannounced keeps recent items without a bluesky link, newest first', () => {
  const now = Date.parse('2026-11-17T00:00:00Z');
  const items = [
    { id: 'old', d: '2026-01-01' }, { id: 'a', d: '2026-11-10' }, { id: 'b', d: '2026-11-15' },
    { id: 'done', d: '2026-11-16', bluesky: 'https://bsky.app/x' },
  ];
  const r = recentUnannounced(items, (x) => new Date(x.d), 30, now);
  assert.deepEqual(r.map((x) => x.id), ['b', 'a']);
});

test('findAnnouncements finds own posts by card or facet, earliest wins, ignores reposts', () => {
  const did = 'did:plc:me';
  const post = (rkey, createdAt, record, extra = {}) => ({ post: { uri: `at://${did}/app.bsky.feed.post/${rkey}`, author: { did }, record: { createdAt, ...record }, ...extra } });
  const feed = [
    post('late', '2026-11-02T00:00:00Z', { embed: { external: { uri: 'https://mpadge.eu/blog/a.html' } } }),
    post('early', '2026-11-01T00:00:00Z', { facets: [{ features: [{ uri: 'https://mpadge.eu/blog/a.html' }] }] }),
    { reason: {}, ...post('repost', '2026-10-01T00:00:00Z', { embed: { external: { uri: 'https://mpadge.eu/blog/a.html' } } }) },
    { post: { uri: 'at://did:plc:other/app.bsky.feed.post/z', author: { did: 'did:plc:other' }, record: { embed: { external: { uri: 'https://mpadge.eu/blog/a.html' } } } } },
  ];
  const found = findAnnouncements(feed, [{ id: 'post:a', url: 'https://mpadge.eu/blog/a.html' }], { did, handle: 'mpadge.eu' });
  assert.deepEqual(found.get('post:a'), { url: 'https://bsky.app/profile/mpadge.eu/post/early', createdAt: '2026-11-01T00:00:00Z', count: 2 });
});

test('addBlueskyField / addBlueskyFieldToNote edit front matter (and blog.yml), once', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atp-'));
  const blogDir = path.join(dir, 'blog'); const notesDir = path.join(dir, 'notes');
  fs.mkdirSync(blogDir); fs.mkdirSync(notesDir);
  fs.writeFileSync(path.join(blogDir, '2026-11-01-hello.md'), '---\ntitle: Hi\nmastodon: https://m/1\nlink: hello.html\n---\nbody\n');
  const blogYml = path.join(dir, 'blog.yml');
  fs.writeFileSync(blogYml, '- title: Hi\n    link: hello.html\n');
  fs.writeFileSync(blogYml, '  - title: Hi\n    link: hello.html\n');
  const md = addBlueskyField('hello', 'hello.html', 'https://bsky.app/profile/x/post/1', { blogYml, blogDir });
  assert.match(fs.readFileSync(md, 'utf8'), /mastodon: https:\/\/m\/1\nbluesky: https:\/\/bsky.app\/profile\/x\/post\/1\n/);
  assert.match(fs.readFileSync(blogYml, 'utf8'), /    bluesky: https:\/\/bsky.app\/profile\/x\/post\/1\n    link: hello.html/);
  assert.throws(() => addBlueskyField('hello', 'hello.html', 'u', { blogYml, blogDir }), /already has a bluesky/);

  fs.writeFileSync(path.join(notesDir, '2026-11-02-n.md'), '---\ntitle: N\n---\nbody\n');
  const nmd = addBlueskyFieldToNote('n', 'https://bsky.app/profile/x/post/2', { notesDir });
  assert.match(fs.readFileSync(nmd, 'utf8'), /title: N\nbluesky: https:\/\/bsky.app\/profile\/x\/post\/2\n---/);
  assert.throws(() => addBlueskyFieldToNote('missing', 'u', { notesDir }), /No markdown source/);
});

test('paginate follows cursors, respects maxPages, handles one page', async () => {
  const pages = { undefined: { items: [1, 2], cursor: 'a' }, a: { items: [3], cursor: 'b' }, b: { items: [4] } };
  assert.deepEqual(await paginate(async (c) => pages[c], (p) => p.items), [1, 2, 3, 4]);
  assert.deepEqual(await paginate(async (c) => pages[c], (p) => p.items, { maxPages: 2 }), [1, 2, 3]);
  assert.deepEqual(await paginate(async () => ({ items: [9] }), (p) => p.items), [9]);
});

test('describeError formats SDK errors and plain errors', () => {
  assert.equal(describeError({ status: 401, error: 'AuthRequired', message: 'bad' }), '401 AuthRequired: bad');
  assert.equal(describeError(new Error('boom')), 'boom');
});

test('printNotification prints text or JSON', () => {
  const n = { service: 'x', time: 't', reason: 'like', handle: 'h', text: 'a\n b', url: 'https://u' };
  const out = [];
  const orig = console.log; console.log = (s) => out.push(s);
  try { printNotification(n, false); printNotification(n, true); } finally { console.log = orig; }
  assert.match(out[0], /^t {2}like {6}h\n {4}a b\n {4}https:\/\/u$/);
  assert.deepEqual(JSON.parse(out[1]), n);
});
