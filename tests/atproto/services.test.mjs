// Offline tests that run tools/atproto code against local mock servers (a PDS and Semble).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { login } from '../../tools/atproto/auth.mjs';
import { unread as sembleUnread } from '../../tools/atproto/notifications-semble.mjs';

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = () => `${b64({ alg: 'none' })}.${b64({ exp: Math.floor(Date.now() / 1000) + 3600, scope: 'com.atproto.appPassPrivileged' })}.sig`;

function serve(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler).listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}
const json = (res, body, status = 200) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); };
const withEnv = async (env, fn) => {
  const old = {};
  for (const k of Object.keys(env)) { old[k] = process.env[k]; if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; }
  try { return await fn(); } finally { for (const k of Object.keys(old)) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; } }
};

test('login: creates a session, stores it 0600, then resumes it without a password', async () => {
  const calls = [];
  const { server, url } = await serve((req, res) => {
    calls.push(`${req.method} ${req.url.split('?')[0].split('/').pop()}`);
    const session = { accessJwt: jwt(), refreshJwt: jwt(), handle: 'test.example', did: 'did:plc:test', active: true };
    if (req.url.includes('createSession') || req.url.includes('refreshSession')) return json(res, session);
    if (req.url.includes('getSession')) return json(res, { handle: 'test.example', did: 'did:plc:test', active: true });
    json(res, { error: 'NotFound' }, 404);
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atp-sess-'));
  const file = path.join(dir, 'state', 'session.json');
  const env = { ATPROTO_PDS: url, ATPROTO_SESSION_FILE: file, ATPROTO_NO_SESSION: undefined };
  try {
    const first = await withEnv({ ...env, ATPROTO_APP_PASSWORD: 'pw' }, () => login({ identifier: 'test.example' }));
    assert.equal(first.did, 'did:plc:test');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pds, url);

    // No password available and `pass` unreachable: only a resumed session can work.
    calls.length = 0;
    const second = await withEnv({ ...env, ATPROTO_APP_PASSWORD: undefined, PATH: '/nonexistent' }, () => login({ identifier: 'test.example' }));
    assert.equal(second.did, 'did:plc:test');
    assert.ok(!calls.some((c) => c.includes('createSession')), `unexpected login: ${calls}`);

    // A session for another PDS is not reused.
    await assert.rejects(
      withEnv({ ...env, ATPROTO_PDS: 'http://127.0.0.1:1', ATPROTO_APP_PASSWORD: undefined, PATH: '/nonexistent' }, () => login({ identifier: 'test.example' })),
      /ATPROTO_APP_PASSWORD/);
  } finally { server.close(); }
});

test('login: ATPROTO_NO_SESSION=1 neither reads nor writes the session file; errors name the purpose', async () => {
  const { server, url } = await serve((req, res) =>
    json(res, { accessJwt: jwt(), refreshJwt: jwt(), handle: 'test.example', did: 'did:plc:test', active: true }));
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'atp-sess-')), 'session.json');
  try {
    await withEnv({ ATPROTO_PDS: url, ATPROTO_SESSION_FILE: file, ATPROTO_NO_SESSION: '1', ATPROTO_APP_PASSWORD: 'pw' }, () => login({ identifier: 'test.example' }));
    assert.ok(!fs.existsSync(file));
    await assert.rejects(login({ identifier: undefined, purpose: 'do the thing' }), /do the thing/);
    await assert.rejects(
      withEnv({ ATPROTO_PDS: url, ATPROTO_SESSION_FILE: file, ATPROTO_NO_SESSION: '1', ATPROTO_APP_PASSWORD: undefined, PATH: '/nonexistent' },
        () => login({ identifier: 'test.example', purpose: 'do the thing' })),
      /do the thing/);
  } finally { server.close(); }
});

test('semble unread: pages through results, sends the key, skips read items, maps fields', async () => {
  const seen = [];
  const user = { id: 'did:plc:u', name: 'U', handle: 'u.test' };
  const { server, url } = await serve((req, res) => {
    const u = new URL(req.url, 'http://h');
    seen.push({ path: u.pathname, page: u.searchParams.get('page'), unreadOnly: u.searchParams.get('unreadOnly'), key: req.headers['x-api-key'] });
    const page = Number(u.searchParams.get('page'));
    const notifications = page === 1
      ? [{ id: 'n1', user, createdAt: '2026-11-17T00:00:01Z', type: 'USER_ADDED_YOUR_CARD', read: false,
          card: { url: 'https://mpadge.eu/blog/a.html', uri: 'at://c/card/1', cardContent: { url: 'u', title: 'A post' } }, collections: [{ name: 'Reading' }] },
         { id: 'n0', user, createdAt: '2026-11-16T00:00:00Z', type: 'USER_FOLLOWED_YOU', read: true }]
      : [{ id: 'n2', user, createdAt: '2026-11-17T00:00:02Z', type: 'USER_FOLLOWED_YOU', read: false }];
    json(res, { notifications, pagination: { hasMore: page < 2 }, unreadCount: 2 });
  });
  try {
    const r = await withEnv({ SEMBLE_API_URL: url, SEMBLE_API_KEY: 'secret' }, () => sembleUnread());
    assert.equal(r.count, 2);
    assert.deepEqual(seen.map((s) => s.page), ['1', '2']);
    assert.ok(seen.every((s) => s.key === 'secret' && s.unreadOnly === 'true' && s.path === '/network.cosmik.notification.list'));
    assert.deepEqual(r.items.map((i) => [i.service, i.reason, i.handle, i.url]), [
      ['semble', 'added-your-card', 'u.test', 'https://mpadge.eu/blog/a.html'],
      ['semble', 'followed-you', 'u.test', 'https://semble.so/profile/u.test'],
    ]);
    assert.equal(r.items[0].text, 'A post [Reading]');
  } finally { server.close(); }
});

test('semble unread: missing key and HTTP errors are reported', async () => {
  await assert.rejects(withEnv({ SEMBLE_API_KEY: undefined, PATH: '/nonexistent' }, () => sembleUnread()), /SEMBLE_API_KEY/);
  const { server, url } = await serve((req, res) => json(res, { error: 'no' }, 401));
  try {
    await assert.rejects(withEnv({ SEMBLE_API_URL: url, SEMBLE_API_KEY: 'bad' }, () => sembleUnread()), /401/);
  } finally { server.close(); }
});
