// Shared @atproto/api clients and DID lookups for the scripts in this directory.
// Scripts receive agents from here; they do not build XRPC URLs or headers.
import { AtpAgent } from '@atproto/api';
import { IdResolver, getPds, getHandle } from '@atproto/identity';

export const APPVIEW = 'https://public.api.bsky.app';
export const DEFAULT_PDS = 'https://tngl.sh';
export const pdsUrl = () => process.env.ATPROTO_PDS || DEFAULT_PDS;

// One cached unauthenticated agent per service URL (many followers share a PDS).
const agents = new Map();
export function agentFor(serviceUrl) {
  if (!agents.has(serviceUrl)) agents.set(serviceUrl, new AtpAgent({ service: serviceUrl }));
  return agents.get(serviceUrl);
}
export const publicAgent = () => agentFor(APPVIEW);

// Follow a cursor until exhausted (or `maxPages`). fetchPage(cursor) returns the SDK's
// `.data`; getItems picks the array out of it.
export async function paginate(fetchPage, getItems, { maxPages = Infinity } = {}) {
  const out = [];
  let cursor;
  for (let i = 0; i < maxPages; i++) {
    const page = await fetchPage(cursor);
    out.push(...getItems(page));
    cursor = page.cursor;
    if (!cursor) break;
  }
  return out;
}

// Format an SDK error (XRPCError carries status and message) for printing.
export function describeError(e) {
  return e?.status ? `${e.status} ${e.error || ''}: ${e.message}`.replace('  ', ' ') : (e?.message || String(e));
}

// DID -> PDS URL / handle through @atproto/identity (did:plc and did:web; cached in memory).
const idResolver = new IdResolver();
export async function pdsOf(did) {
  const doc = await idResolver.did.resolve(did);
  return doc ? getPds(doc) : undefined;
}
const handles = new Map();
export async function handleOf(did) {
  if (!handles.has(did)) {
    let h = did;
    try {
      const doc = await idResolver.did.resolve(did);
      h = (doc && getHandle(doc)) || did;
    } catch { /* leave as DID */ }
    handles.set(did, h);
  }
  return handles.get(did);
}
