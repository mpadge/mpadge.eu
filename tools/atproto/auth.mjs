// Login for scripts that write to (or read private state from) the PDS.
//
// Credentials: ATPROTO_IDENTIFIER, ATPROTO_APP_PASSWORD (else first line of
// `pass show atproto/app-password`), ATPROTO_PDS (default https://tngl.sh).
//
// Session reuse: the session is kept in a private file outside the repository
// ($ATPROTO_SESSION_FILE, else $XDG_STATE_HOME/mpadge-atproto/session.json, else
// ~/.local/state/mpadge-atproto/session.json; directory 0700, file 0600) and resumed on
// the next run, so no app password lookup or createSession call is needed. It is plaintext
// at rest: keep it out of shared backups and synced folders. Skip it with --no-session or
// ATPROTO_NO_SESSION=1. Tokens are never printed.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { AtpAgent } from '@atproto/api';
import { pdsUrl } from './agent.mjs';

const sessionFile = () => process.env.ATPROTO_SESSION_FILE
  || path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'mpadge-atproto', 'session.json');
const sessionsDisabled = () => process.argv.includes('--no-session') || process.env.ATPROTO_NO_SESSION === '1';

function loadSession(identifier, pds) {
  try {
    const { session, pds: savedPds } = JSON.parse(fs.readFileSync(sessionFile(), 'utf8'));
    if (savedPds !== pds || (session.did !== identifier && session.handle !== identifier)) return undefined;
    return session;
  } catch { return undefined; }
}

function saveSession(session, pds) {
  const file = sessionFile();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ pds, session }), { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

const clearSession = () => { try { fs.rmSync(sessionFile(), { force: true }); } catch { /* ignore */ } };

function appPassword() {
  let password = process.env.ATPROTO_APP_PASSWORD;
  if (!password) {
    try {
      password = execFileSync('pass', ['show', 'atproto/app-password'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n')[0].trim();
    } catch { /* handled below */ }
  }
  return password;
}

// Returns { agent, did, identifier, pds }.
export async function login({ identifier = process.env.ATPROTO_IDENTIFIER, purpose = 'log in' } = {}) {
  if (!identifier) throw new Error(`Set ATPROTO_IDENTIFIER to ${purpose}`);
  const pds = pdsUrl();
  const useSession = !sessionsDisabled();
  const agent = new AtpAgent({
    service: pds,
    persistSession: useSession ? (evt, session) => {
      if ((evt === 'create' || evt === 'update') && session) saveSession(session, pds);
      else if (evt === 'expired') clearSession();
    } : undefined,
  });

  const saved = useSession ? loadSession(identifier, pds) : undefined;
  if (saved) {
    try {
      await agent.resumeSession(saved);
      return { agent, did: agent.session.did, identifier, pds };
    } catch { clearSession(); /* fall through to a fresh login */ }
  }
  const password = appPassword();
  if (!password) throw new Error(`Set ATPROTO_APP_PASSWORD or add atproto/app-password to pass (needed to ${purpose})`);
  await agent.login({ identifier, password });
  return { agent, did: agent.session.did, identifier, pds };
}
