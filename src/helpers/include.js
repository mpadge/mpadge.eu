const fs = require('fs');
const path = require('path');
const Handlebars = require('handlebars');

// Include a file (path relative to project root), rendering it as a Handlebars
// template with the current context, so `{{root}}` etc. work. Intended for use
// inside `{{#markdown}}` blocks.
module.exports = function include(file) {
  const src = fs.readFileSync(path.join(process.cwd(), file), 'utf8');
  return Handlebars.compile(src)(this);
};
