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
import { blogPages as _blogPages } from './tools/blogPages.js';
import { updateLlmsTxt }            from './tools/llmsTxt.js';
import { execSync }                from 'child_process';

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
  gulp.series(clean, updateLlmsTxt, gulp.parallel(pages, blogPages, javascript, images, copy), sassBuild, cname)
);

// Build the site, run the server, and watch for file changes
gulp.task('default',
  gulp.series('build', server, watch)
);

// Compressing images is slow, so production builds keep the already-compressed
// images in dist/assets/img and only process new or changed ones (see images()).
// A marker file records that the directory holds production-compressed images;
// dev builds delete it (a full clean), so uncompressed dev copies are never reused.
// Pass --fresh-images to force recompressing everything.
const IMG_DIR = path.resolve(PATHS.dist, 'assets', 'img');
const IMG_MARKER = path.join(IMG_DIR, '.compressed');
const FRESH_IMAGES = !!(yargs(hideBin(process.argv)).argv['fresh-images']);

// Delete the "dist" folder
// This happens every time a build starts
function clean() {
  const keepImages = PRODUCTION && !FRESH_IMAGES && fs.existsSync(IMG_MARKER);
  return rimraf(PATHS.dist, {
    // Entries for which filter returns false (and their parents) are kept
    filter: (p) => !(keepImages && (p === IMG_DIR || p.startsWith(IMG_DIR + path.sep)))
  });
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

// Copy images to the "dist" folder
// In production, the images are compressed, and only those that are new or
// changed since the last production build are processed
function images() {
  return gulp.src('src/assets/img/**/*', { encoding: false })
    .pipe($.newer(IMG_DIR))
    .pipe($.if(PRODUCTION, imagemin([
      gifsicle({interlaced: true}),
      mozjpeg({quality: 85, progressive: true}),
      optipng({optimizationLevel: 5}),
      svgo({
        // svgo 3: removeViewBox is on by default in preset-default
        plugins: [
          {name: 'preset-default', params: {overrides: {cleanupIds: false}}}
        ]
      })
    ])))
    .pipe(gulp.dest(IMG_DIR))
    .on('finish', () => {
      if (PRODUCTION) {
        fs.mkdirSync(IMG_DIR, { recursive: true });
        fs.writeFileSync(IMG_MARKER, '');
      }
    });
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
  gulp.watch('src/{layouts,partials}/**/*.html').on('all', gulp.series(resetPages, pages, browser.reload));
  gulp.watch('src/data/**/*.{js,json,yml}').on('all', gulp.series(resetPages, pages, browser.reload));
  gulp.watch('src/helpers/**/*.js').on('all', gulp.series(resetPages, pages, browser.reload));
  gulp.watch('src/assets/scss/**/*.scss').on('all', sassBuild);
  gulp.watch('src/assets/js/**/*.js').on('all', gulp.series(javascript, browser.reload));
  gulp.watch('src/assets/img/**/*').on('all', gulp.series(images, browser.reload));
}
