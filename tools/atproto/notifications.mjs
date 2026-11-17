// Notifications for mpadge.eu, from Bluesky, Semble and Tangled.
//
//   node tools/atproto/notifications.mjs --unread [--json] [--actor=other.handle]
//       Unread notifications from Bluesky (AppView, via your PDS login), Semble (API key) and Tangled. Needs logins: see notifications-bluesky.mjs (ATPROTO_*, `pass atproto/app-password`)
//       and notifications-semble.mjs (SEMBLE_API_KEY, `pass semble/api-key`). If one service fails
//       (e.g. no Semble key), the other is still shown and the exit code is 1. Read-only.
//       Tangled has no notifications API, so notifications-tangled.mjs approximates one from its public
//       AppView (stars, issues, pull requests, comments, follows; add --mark-seen to remember them).
//       --only=bluesky, --only=semble or --only=tangled restricts it to one.
//   node tools/atproto/notifications.mjs [--since=6h|--follow|--state=...|--duration=...|--json]
//       Without --unread: the Jetstream scan from notifications-bluesky.mjs (see its header for the
//       options). Semble has no equivalent.
//
// With --json, each line has a `service` field ("bluesky", "semble" or "tangled").
import { argValue, printNotification } from './notifications-common.mjs';
import * as bluesky from './notifications-bluesky.mjs';
import * as semble from './notifications-semble.mjs';
import * as tangled from './notifications-tangled.mjs';

const actor = argValue('actor') || 'mpadge.eu';

if (!process.argv.includes('--unread')) {
  await bluesky.scan({ actor });
} else {
  const asJson = process.argv.includes('--json');
  const only = argValue('only');
  if (only && !['bluesky', 'semble', 'tangled'].includes(only)) throw new Error('--only must be bluesky, semble or tangled');
  const services = [['bluesky', () => bluesky.unread({ actor })], ['semble', () => semble.unread()],
    ['tangled', () => tangled.unread({ actor })]]
    .filter(([name]) => !only || only === name);
  let failed = 0;
  for (const [name, run] of services) {
    try {
      const { count, items } = await run();
      console.error(`# ${name}: ${count} unread; ${items.length} listed`);
      for (const n of items) printNotification(n, asJson);
    } catch (e) {
      failed++;
      console.error(`# ${name} failed: ${e.message}`);
    }
  }
  process.exit(failed ? 1 : 0);
}
