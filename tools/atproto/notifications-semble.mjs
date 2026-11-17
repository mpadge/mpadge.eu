// Unread Semble notifications (https://docs.cosmik.network/semble-api/notifications).
//
//   node tools/atproto/notifications-semble.mjs [--json]
//
// (notifications.mjs --unread runs this together with notifications-bluesky.mjs.)
//
// Needs a Semble API key (create one at https://semble.so/settings/api-keys): SEMBLE_API_KEY, else the
// first line of `pass show semble/api-key`. It is sent as the `x-api-key` header to
// https://api.semble.so/xrpc (override with SEMBLE_API_URL). Semble's API is plain REST, not atproto
// XRPC against a PDS, so @atproto/api does not apply and this uses fetch. Only READS: markRead and
// markAllRead are never called, so the unread badge on semble.so is left alone.
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { paginate } from './agent.mjs';
import { printNotification } from './notifications-common.mjs';

const base = () => process.env.SEMBLE_API_URL || 'https://api.semble.so/xrpc';
const PAGE_SIZE = 50;

function apiKey() {
  let key = process.env.SEMBLE_API_KEY;
  if (!key) {
    try {
      key = execFileSync('pass', ['show', 'semble/api-key'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n')[0].trim();
    } catch { /* handled below */ }
  }
  if (!key) throw new Error('Set SEMBLE_API_KEY or add semble/api-key to pass (key from https://semble.so/settings/api-keys)');
  return key;
}

async function get(key, method, query) {
  const res = await fetch(`${base()}/${method}?${new URLSearchParams(query)}`, {
    headers: { 'x-api-key': key, 'x-semble-client': 'mpadge-notifications' },
  });
  if (!res.ok) throw new Error(`Semble ${method}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// One-line description of what the notification is about.
function describe(n) {
  const card = n.card?.cardContent?.title || n.card?.url;
  const colls = (n.collections || []).map((c) => c.name).filter(Boolean).join(', ');
  switch (n.type) {
    case 'USER_FOLLOWED_YOU': return undefined;
    case 'USER_FOLLOWED_YOUR_COLLECTION': return colls || undefined;
    case 'USER_CONNECTED_YOUR_URL': case 'USER_CONNECTED_YOUR_POST': case 'USER_CONNECTED_YOUR_COLLECTION':
    case 'SUBSCRIBED_USER_MADE_CONNECTION': case 'USER_CONNECTED_SUBSCRIBED_COLLECTION': {
      const c = n.connection?.connection;
      return [n.connection?.source?.url, c?.type, n.connection?.target?.url].filter(Boolean).join(' -> ') || undefined;
    }
    default: return [card, colls && `[${colls}]`].filter(Boolean).join(' ') || n.mentionCollection?.name || undefined;
  }
}

// Where to look: the saved URL for card activity, else the other user's Semble profile.
function link(n) {
  if (n.card?.url) return n.card.url;
  return n.user?.handle ? `https://semble.so/profile/${n.user.handle}` : undefined;
}

// Returns { count, items } in the common notification shape; prints nothing.
export async function unread() {
  const key = apiKey();
  let count = 0;
  const items = await paginate(async (cursor) => {
    const page = cursor ?? 1;
    const r = await get(key, 'network.cosmik.notification.list',
      { page, limit: PAGE_SIZE, sortOrder: 'desc', unreadOnly: 'true' });
    count = r.unreadCount ?? count;
    return { notifications: r.notifications || [], cursor: r.pagination?.hasMore ? page + 1 : undefined };
  }, (r) => r.notifications.filter((n) => !n.read));
  return {
    count,
    items: items.map((n) => ({
      service: 'semble', time: n.createdAt, reason: n.type.toLowerCase().replace(/^user_/, '').replace(/_/g, '-'),
      handle: n.user?.handle, did: n.user?.id, uri: n.card?.uri || n.id, text: describe(n), url: link(n),
    })),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { count, items } = await unread();
  console.error(`# ${count} unread (Semble); ${items.length} listed`);
  for (const n of items) printNotification(n, process.argv.includes('--json'));
  process.exit(0);
}
