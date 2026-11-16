// Build the /notes/ section: one page per src/pages/notes/YYYY-MM-DD-slug.md
// plus a generated index. Notes are short, so they use a simple layout (no
// sidenotes or section navigation).
import panini  from 'panini';
import through2 from 'through2';
import Vinyl   from 'vinyl';
import path    from 'path';
import fs      from 'fs';
import * as yaml from 'js-yaml';
import marked  from 'marked';
import gulp    from 'gulp';

const SITE = 'https://mpadge.eu';
const NOTES_DIR = 'src/pages/notes';

export function parseNote(file, raw) {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  const fm = m ? (yaml.load(m[1]) || {}) : {};
  const slug = path.basename(file, '.md').replace(/^\d{4}-\d{2}-\d{2}-/, '');
  const date = fm.date instanceof Date ? fm.date.toISOString().slice(0, 10) : String(fm.date || '');
  return { slug, date, title: fm.title || slug, description: fm.description || '',
           tags: fm.tags ? String(fm.tags) : '', body: m ? m[2] : raw };
}

export function loadNotes() {
  if (!fs.existsSync(NOTES_DIR)) return [];
  return fs.readdirSync(NOTES_DIR).filter((f) => /^\d{4}.*\.md$/.test(f))
    .map((f) => parseNote(f, fs.readFileSync(path.join(NOTES_DIR, f), 'utf8')))
    .sort((a, b) => b.date.localeCompare(a.date));
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const shortDate = (d) => { // "2026-11-15" -> "15 Nov 26", the format used in blog.yml
  const [y, m, day] = d.split('-');
  return `${day} ${MONTHS[+m - 1]} ${y.slice(2)}`;
};

// Write src/data/notesshort.yml (the n most recent notes, for the home page).
// Must run before panini loads src/data/, so it is its own gulp task.
export function writeNotesShort(n = 6) {
  const entries = loadNotes().slice(0, n).map((x) => ({
    title: x.title, description: x.description, created: shortDate(x.date),
    ...(x.tags && { tags: x.tags }), link: `notes/${x.slug}.html`,
  }));
  fs.writeFileSync('src/data/notesshort.yml', yaml.dump(entries.length ? entries : []));
  return Promise.resolve();
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
// Handlebars would otherwise interpret braces in note text
const hbs = (s) => s.replace(/\{\{/g, '\\{{');

function frontMatter(title, description, pageUrl, atprotoUri) {
  return `---\ntitle: "${esc(title)}"\nsitetitle: mp\n` +
    (description ? `description: "${description.replace(/"/g, '\\"')}"\n` : '') +
    `pageurl: "${pageUrl}"\n` +
    (atprotoUri ? `atproto: "${atprotoUri}"\n` : '') + '---\n';
}

const WRAP_OPEN = '{{> header}}\n<div class="pageClass">\n<div class="grid-container">\n' +
  '<div class="grid-x grid-padding-x">\n<div class="cell medium-11 large-11">\n';
const WRAP_CLOSE = '\n</div>\n</div>\n</div>\n</div>\n{{> footer}}\n';

// Notes have no sidenote panel, so footnotes ([^label] / [^label]: text) are
// rendered as numbered endnotes with links back and forth.
function processFootnotes(md) {
  const defs = {};
  const order = [];
  const defRe = /^\[\^([^\]]+)\]:\s*(.+(?:\n[ \t]+.+)*)$/gm;
  let m;
  while ((m = defRe.exec(md)) !== null) defs[m[1]] = m[2].replace(/\n[ \t]+/g, ' ').trim();
  let content = md.replace(/^\[\^[^\]]+\]:\s*.+(?:\n[ \t]+.+)*\n?/gm, '');
  content = content.replace(/\[\^([^\]]+)\]/g, (full, label) => {
    if (!defs[label]) return full;
    if (!order.includes(label)) order.push(label);
    const num = order.indexOf(label) + 1;
    return `<sup class="footnote-ref" id="fnref-${num}"><a href="#fn-${num}">${num}</a></sup>`;
  });
  const items = order.map((label, i) => {
    const num = i + 1;
    const body = marked(defs[label]).trim().replace(/^<p>/, '').replace(/<\/p>$/, '');
    return `<li id="fn-${num}">${body} <a href="#fnref-${num}" class="footnote-back">&#8617;</a></li>`;
  });
  const html = items.length ? `<hr>\n<ol class="footnotes">\n${items.join('\n')}\n</ol>\n` : '';
  return { content, html };
}

function notePage(n, atprotoUri) {
  const fn = processFootnotes(n.body);
  const html = marked(fn.content) + fn.html;
  return frontMatter(n.title, n.description, `${SITE}/notes/${n.slug}.html`, atprotoUri) +
    WRAP_OPEN +
    `<p><a href="{{root}}notes">&larr; notes</a></p>\n<h1>${esc(n.title)}</h1>\n` +
    `<p class="blog-date">${n.date}</p>\n` + hbs(html) + WRAP_CLOSE;
}

function indexPage(notes) {
  const items = notes.map((n) =>
    `<div class="note-entry">\n<h3><a href="${n.slug}.html">${esc(n.title)}</a></h3>\n` +
    `<p class="blog-date">${n.date}</p>\n` +
    (n.description ? `<p>${esc(n.description)}</p>\n` : '') + '</div>').join('\n');
  return frontMatter('notes', 'Short notes.', `${SITE}/notes/`) + WRAP_OPEN +
    '<h1>notes</h1>\n<h4>Short notes</h4>\n' + (items || '<p>Nothing yet.</p>') + WRAP_CLOSE;
}

export function notesPages(PATHS) {
  const atproto = fs.existsSync('src/atproto.json')
    ? (JSON.parse(fs.readFileSync('src/atproto.json', 'utf8')).noteDocuments || {}) : {};
  const notes = [];
  return gulp.src(`${NOTES_DIR}/*.md`, { base: 'src/pages/' })
    .pipe(through2.obj(function (file, enc, cb) {
      const n = parseNote(file.path, file.contents.toString(enc));
      notes.push(n);
      file.contents = Buffer.from(notePage(n, atproto[`${n.slug}.html`] || ''));
      file.path = path.join(file.base, 'notes', `${n.slug}.html`);
      cb(null, file);
    }, function (cb) {
      notes.sort((a, b) => b.date.localeCompare(a.date));
      this.push(new Vinyl({ cwd: process.cwd(), base: path.resolve('src/pages/'),
        path: path.resolve('src/pages/notes/index.html'),
        contents: Buffer.from(indexPage(notes)) }));
      cb();
    }))
    .pipe(panini({
      root: 'src/pages/', layouts: 'src/layouts/', partials: 'src/partials/',
      data: 'src/data/', helpers: 'src/helpers/',
    }))
    .pipe(gulp.dest(PATHS.dist));
}
