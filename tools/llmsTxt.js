import fs   from 'fs';
import yaml from 'js-yaml';

const FILE   = 'src/llms.txt';
const BEGIN  = '<!-- BEGIN POSTS (generated from src/data/blog.yml by tools/llmsTxt.js) -->';
const END    = '<!-- END POSTS -->';
const SITE   = 'https://mpadge.eu';

function firstSentence(s) {
  const text = String(s || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
  const m = text.match(/^.*?[.!?](?=\s|$)/);
  return m ? m[0] : text;
}

// Rewrite the block between BEGIN/END markers in src/llms.txt with one entry
// per post in src/data/blog.yml (file order, which is newest first).
export function updateLlmsTxt() {
  const posts = yaml.load(fs.readFileSync('src/data/blog.yml', 'utf8')) || [];
  const lines = posts.filter(p => p && p.title && p.link).map(p => {
    const desc = firstSentence(p.description);
    return `- [${String(p.title).trim()}](${SITE}/blog/${p.link})` + (desc ? `: ${desc}` : '');
  });
  const block = [BEGIN, '## Blog posts', '', ...lines, END].join('\n');

  const old = fs.readFileSync(FILE, 'utf8');
  const i = old.indexOf(BEGIN), j = old.indexOf(END);
  if (i < 0 || j < i) throw new Error(`${FILE}: BEGIN/END POSTS markers not found`);
  const next = old.slice(0, i) + block + old.slice(j + END.length);
  if (next !== old) fs.writeFileSync(FILE, next);
  return Promise.resolve();
}
