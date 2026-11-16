import plugins       from 'gulp-load-plugins';
import yargs         from 'yargs';
import { hideBin }   from 'yargs/helpers';
import browser       from 'browser-sync';
import gulp          from 'gulp';
import panini        from 'panini';
import { rimraf }    from 'rimraf';
import sherpa        from 'style-sherpa';
import fs            from 'fs';
import path          from 'path';
import webpackStream from 'webpack-stream';
import webpack2      from 'webpack';
import named         from 'vinyl-named';
import autoprefixer  from 'autoprefixer';
import imagemin, { gifsicle, mozjpeg, optipng, svgo } from 'gulp-imagemin';
import { blogPages as _blogPages } from './tools/site/blogPages.js';
import { notesPages as _notesPages, writeNotesShort, writeNotesData } from './tools/site/notesPages.js';
import { updateLlmsTxt }            from './tools/site/llmsTxt.js';
import { execSync }                from 'child_process';
import { Transform }               from 'stream';

import gulpSass      from 'gulp-sass';
import * as dartSass from 'sass-embedded';
import postcss       from 'gulp-postcss';
import uncss         from 'postcss-uncss';
import sourcemaps    from 'gulp-sourcemaps';
import plumber       from 'gulp-plumber';
import { load as yamlLoad, CORE_SCHEMA, defineScalarTag, NOT_RESOLVED } from 'js-yaml';

const sass = gulpSass(dartSass);

// js-yaml 5 dropped the Type API that js-yaml-js-types relied on, so define
// the one custom tag config.yml uses (`!!js/regexp /pattern/flags`) directly.
const regexpTag = defineScalarTag('tag:yaml.org,2002:js/regexp', {
  resolve(source) {
    const m = /^\/([\s\S]*)\/([a-z]*)$/.exec(source);
    return m ? new RegExp(m[1], m[2]) : NOT_RESOLVED;
  },
  identify: (data) => data instanceof RegExp,
  represent: (data) => String(data),
});

// Load all Gulp plugins into one variable
const $ = plugins({ config: path.resolve('package.json') });

// Check for --production flag
const PRODUCTION = !!(yargs(hideBin(process.argv)).argv.production);

// Load settings from settings.yml
function loadConfig() {
  const schema = CORE_SCHEMA.withTags(regexpTag);
  const ymlFile = fs.readFileSync('config.yml', 'utf8');
  return yamlLoad(ymlFile, {schema});
}
const { PORT, UNCSS_OPTIONS, PATHS } = loadConfig();

console.log(UNCSS_OPTIONS);

// Build the "dist" folder by running all of the below tasks
// Sass must be run later so UnCSS can search for used classes in the others assets.
gulp.task('build',
  gulp.series(clean, updateLlmsTxt, notesData, gulp.parallel(pages, blogPages, notesPages, javascript, images, copy), sassBuild, cname, atprotoWellKnown)
);

// Build the site, run the server, and watch for file changes
gulp.task('default',
  gulp.series('build', server, watch)
);

// Compressing images is slow, so production builds write compressed copies
// next to the originals in src/assets/img as `<name>-compressed.<ext>`, and only
// process images that are new or changed since their compressed copy was made.
// The compressed copies are then copied into dist/assets/img with the
// `-compressed` suffix removed (the originals are not copied). Dev builds skip
// compression and copy the originals. Pass --fresh-images to recompress everything.
const IMG_SRC   = 'src/assets/img';
const IMG_DIST  = path.resolve(PATHS.dist, 'assets', 'img');
const SUFFIX    = '-compressed';
const FRESH_IMAGES = !!(yargs(hideBin(process.argv)).argv['fresh-images']);

const isCompressed = (p) => path.parse(p).name.endsWith(SUFFIX);
const compressedName = (p) => {
  const { dir, name, ext } = path.parse(p);
  return path.join(dir, name + SUFFIX + ext);
};
const originalName = (p) => {
  const { dir, name, ext } = path.parse(p);
  return path.join(dir, name.slice(0, -SUFFIX.length) + ext);
};

// Object-mode stream that drops directories and any file failing keep(path).
// (gulp.src's `nodir` is not reliable here; a directory vinyl reaching mapPath
// would be renamed and created as a junk `<dir>-compressed` directory.)
function filesOnly(keep = () => true) {
  return new Transform({
    objectMode: true,
    transform(file, _enc, cb) { cb(null, file.isDirectory() || !keep(file.path) ? null : file); }
  });
}

// Object-mode stream applying fn to each vinyl file's path
function mapPath(fn) {
  return new Transform({
    objectMode: true,
    transform(file, _enc, cb) { file.path = fn(file.path); cb(null, file); }
  });
}

// Delete the "dist" folder
// This happens every time a build starts
function clean() {
  return rimraf(PATHS.dist);
}

// Copy files out of the assets folder
// This task skips over the "img", "js", and "scss" folders, which are parsed separately
function copy() {
  gulp.src(PATHS.assets, { encoding: false })
    .pipe(gulp.dest(PATHS.dist + '/assets'));
  // Also copy generated feed.xml and llms.txt to root of dist
  return gulp.src(['src/feed.xml', 'src/llms.txt'])
    .pipe(gulp.dest(PATHS.dist));
}

// Verify site.standard.publication records (https://standard.site).
// The root publication must be served at /.well-known/site.standard.publication,
// and a publication at a sub-path (e.g. /notes) at
// /.well-known/site.standard.publication/notes. A static file and directory
// cannot share the name, so when sub-path publications exist the root AT-URI is
// written to site.standard.publication.txt and served at the root URL through
// a forced statichost.eu rewrite (https://www.statichost.eu/docs/routing/).
function atprotoWellKnown() {
  if (!fs.existsSync('src/atproto.json')) return Promise.resolve();
  const { publication, publications = {} } = JSON.parse(fs.readFileSync('src/atproto.json', 'utf8'));
  if (!publication) return Promise.resolve();
  const wk = PATHS.dist + '/.well-known';
  const sub = Object.entries(publications);
  fs.mkdirSync(wk, { recursive: true });
  if (sub.length === 0) {
    fs.writeFileSync(wk + '/site.standard.publication', publication);
    return Promise.resolve();
  }
  fs.writeFileSync(wk + '/site.standard.publication.txt', publication);
  fs.mkdirSync(wk + '/site.standard.publication', { recursive: true });
  for (const [path, uri] of sub) {
    fs.writeFileSync(`${wk}/site.standard.publication/${path}`, uri);
  }
  fs.appendFileSync(PATHS.dist + '/_redirects',
    '/.well-known/site.standard.publication /.well-known/site.standard.publication.txt 200!\n');
  return Promise.resolve();
}

function cname() {
  fs.writeFileSync(PATHS.dist + '/CNAME', 'mpadge.eu');
  return Promise.resolve();
}

// Copy page templates into finished HTML files
function pages() {
  return gulp.src('src/pages/**/*.{html,hbs,handlebars,xml}')
    .pipe(panini({
      root: 'src/pages/',
      layouts: 'src/layouts/',
      partials: 'src/partials/',
      data: 'src/data/',
      helpers: 'src/helpers/'
    }))
    .pipe(gulp.dest(PATHS.dist));
}

function blogPages() { return _blogPages(PATHS); }
function notesData() { return Promise.all([writeNotesShort(), writeNotesData()]); }
function notesPages() { return _notesPages(PATHS); }

// Load updated HTML templates and partials into Panini
function resetPages(done) {
  panini.refresh();
  done();
}

// Compile Sass into CSS
// In production, the CSS is compressed
function sassBuild() {

  const postCssPlugins = [
    // Autoprefixer
    autoprefixer(),
    // UnCSS - Uncomment to remove unused styles in production
    // PRODUCTION && uncss(UNCSS_OPTIONS),
  ].filter(Boolean);

  return gulp.src('src/assets/scss/app.scss')
  .pipe(sourcemaps.init())
  .pipe(plumber())
  .pipe(sass({
    loadPaths: PATHS.sass,
    silenceDeprecations: ['legacy-js-api', 'import', 'global-builtin', 'color-functions', 'slash-div'],
    quietDeps: true
  }).on('error', sass.logError))
  .pipe(postcss(postCssPlugins))
  .pipe(sourcemaps.write('.'))
  .pipe(gulp.dest(PATHS.dist + '/assets/css'))
  .pipe(browser.reload({ stream: true }));
}

let webpackConfig = {
  mode: (PRODUCTION ? 'production' : 'development'),
  module: {
    rules: [
      {
        test: /\.js$/,
        use: {
          loader: 'babel-loader',
          options: {
            presets: [ "@babel/preset-env" ],
            compact: false
          }
        }
      }
    ]
  },
  devtool: !PRODUCTION && 'source-map'
}

// Combine JavaScript into one file
// In production, the file is minified
function javascript() {
  return gulp.src(PATHS.entries)
    .pipe(named())
    .pipe($.sourcemaps.init())
    .pipe(webpackStream(webpackConfig, webpack2))
    .pipe($.if(PRODUCTION, $.terser()
      .on('error', e => { console.log(e); })
    ))
    .pipe($.if(!PRODUCTION, $.sourcemaps.write()))
    .pipe(gulp.dest(PATHS.dist + '/assets/js'));
}

// Compress images that are new or changed into `-compressed` siblings.
// Compressed copies whose original has been deleted are removed.
async function compressImages() {
  walk(IMG_SRC).filter(isCompressed).forEach((f) => {
    if (FRESH_IMAGES || !fs.existsSync(originalName(f))) fs.rmSync(f);
  });
  await new Promise((resolve, reject) => {
    gulp.src(IMG_SRC + '/**/*', { encoding: false })
      .pipe(filesOnly((p) => !isCompressed(p)))
      .pipe($.newer({ dest: IMG_SRC, map: (rel) => compressedName(rel) }))
      .pipe(imagemin([
        gifsicle({interlaced: true}),
        mozjpeg({quality: 85, progressive: true}),
        optipng({optimizationLevel: 5}),
        svgo({
          // svgo 3: removeViewBox is on by default in preset-default
          plugins: [
            {name: 'preset-default', params: {overrides: {cleanupIds: false}}}
          ]
        })
      ]))
      .pipe(mapPath(compressedName))
      .pipe(gulp.dest(IMG_SRC))
      .on('finish', resolve)
      .on('error', reject);
  });
}

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
}

// Copy images to the "dist" folder: the compressed copies (suffix removed) in
// production, the originals otherwise
function copyImages() {
  return gulp.src(IMG_SRC + '/**/*', { encoding: false })
    .pipe(filesOnly(PRODUCTION ? isCompressed : (p) => !isCompressed(p)))
    .pipe(PRODUCTION ? mapPath(originalName) : new Transform({ objectMode: true, transform(f, _e, cb) { cb(null, f); } }))
    .pipe(gulp.dest(IMG_DIST));
}

function images(done) {
  return gulp.series(...(PRODUCTION ? [compressImages, copyImages] : [copyImages]))(done);
}

// Start a server with BrowserSync to preview the site in
function server(done) {
  browser.init({
    server: PATHS.dist, port: PORT
  }, done);
}

// Reload the browser with BrowserSync
function reload(done) {
  browser.reload();
  done();
}

// Watch for changes to static assets, pages, Sass, and JavaScript
function watch() {
  gulp.watch(PATHS.assets, copy);
  gulp.watch('src/pages/**/*.html').on('all', gulp.series(pages, browser.reload));
  gulp.watch('src/pages/blog/*.md').on('all', gulp.series(blogPages, browser.reload));
  // Notes also feed the home page via src/data/notesshort.yml and the notes index
  // via src/data/notes.yml, so regenerate them,
  // refresh Panini's cached data, then rebuild both the notes and the home page.
  gulp.watch('src/pages/notes/*.md').on('all',
    gulp.series(notesData, resetPages, notesPages, pages, browser.reload));
  gulp.watch('src/atproto.json').on('all',
    gulp.series(resetPages, blogPages, notesPages, browser.reload));
  gulp.watch('src/{layouts,partials}/**/*.html').on('all', gulp.series(resetPages, pages, browser.reload));
  gulp.watch('src/data/**/*.{js,json,yml}').on('all', gulp.series(resetPages, pages, browser.reload));
  gulp.watch('src/helpers/**/*.js').on('all', gulp.series(resetPages, pages, browser.reload));
  gulp.watch('src/assets/scss/**/*.scss').on('all', sassBuild);
  gulp.watch('src/assets/js/**/*.js').on('all', gulp.series(javascript, browser.reload));
  gulp.watch('src/assets/img/**/*').on('all', gulp.series(images, browser.reload));
}
