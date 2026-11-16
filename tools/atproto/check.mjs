// Check that src/atproto.json is consistent with the site content, so that
// `make publish` cannot have been forgotten before a commit/build/deploy.
//
//   node tools/atproto/check.mjs
//
// Fails (exit 1) if:
//   - any blog post (src/data/blog.yml) or note has no AT-URI in src/atproto.json
//   - src/atproto.json contains the dry-run placeholder DID
//   - src/atproto.json has unstaged changes (only when run inside a git repo)
import fs from 'fs';
import { execFileSync } from 'child_process';
import * as yaml from 'js-yaml';
import { loadNotes } from '../site/notesPages.js';

const FILE = 'src/atproto.json';
const problems = [];

if (!fs.existsSync(FILE)) {
  console.error(`${FILE} is missing: run 'make publish'`);
  process.exit(1);
}
const raw = fs.readFileSync(FILE, 'utf8');
const atproto = JSON.parse(raw);

if (raw.includes('did:plc:DRYRUN')) problems.push(`${FILE} contains dry-run placeholder DIDs`);

const posts = yaml.load(fs.readFileSync('src/data/blog.yml', 'utf8')).filter((e) => e && e.link);
for (const p of posts) {
  if (!atproto.documents?.[p.link]) problems.push(`blog post without atproto record: ${p.link}`);
}
for (const n of loadNotes()) {
  if (!atproto.noteDocuments?.[`${n.slug}.html`]) problems.push(`note without atproto record: ${n.slug}`);
}

try {
  const unstaged = execFileSync('git', ['diff', '--name-only', '--', FILE], { encoding: 'utf8' }).trim();
  if (unstaged) problems.push(`${FILE} has unstaged changes: 'git add ${FILE}'`);
} catch { /* not a git repo: skip */ }

if (problems.length) {
  console.error('atproto check failed:');
  for (const p of problems) console.error(`  - ${p}`);
  console.error("Run 'make publish' (after 'make update'), then stage src/atproto.json.");
  process.exit(1);
}
console.log('atproto check OK');
