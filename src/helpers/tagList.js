// Split a comma-separated tag string ("code, git") into an array of tags, for
// use as {{#each (tagList tags)}}.
module.exports = function tagList(str) {
  if (typeof str !== 'string') return [];
  return str.split(',').map((t) => t.trim()).filter(Boolean);
};
