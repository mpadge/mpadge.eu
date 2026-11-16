// Comments from Mastodon and/or Bluesky, rendered client-side from the public
// (unauthenticated) APIs of each. Each blog page has
//   <div id="comments" data-mastodon-url="..." data-bluesky-url="..."></div>
// and either, both, or neither of the URLs may be set. Replies from both
// sources are merged into one list: top-level replies in chronological order,
// each followed by its own (nested) thread.
(function () {
    var container = document.getElementById('comments');
    if (!container) return;

    var mastodonUrl = container.dataset.mastodonUrl || '';
    var blueskyUrl = container.dataset.blueskyUrl || '';
    if (!mastodonUrl && !blueskyUrl) return;

    var BSKY_API = 'https://public.api.bsky.app/xrpc/';

    var loaders = [];
    if (mastodonUrl) loaders.push(loadMastodon(mastodonUrl));
    if (blueskyUrl) loaders.push(loadBluesky(blueskyUrl));
    Promise.all(loaders).then(render);

    // ---------------------------------------------------------------- helpers

    function relativeTime(isoStr) {
        var then = new Date(isoStr).getTime();
        var diff = Math.floor((Date.now() - then) / 1000);
        if (diff < 60) return Math.max(diff, 0) + 's ago';
        if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
        if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
        if (diff < 2592000) return Math.floor(diff / 86400) + 'd ago';
        if (diff < 31536000) return Math.floor(diff / 2592000) + 'mo ago';
        return Math.floor(diff / 31536000) + 'y ago';
    }

    function escapeHtml(str) {
        return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function getJson(url) {
        return fetch(url).then(function (r) {
            if (!r.ok) throw new Error(url + ': ' + r.status);
            return r.json();
        });
    }

    // ------------------------------------------------------------------ Mastodon

    // Each loader resolves (never rejects) to
    //   { source, label, replyUrl, rootKey, ok, nodes: [{ key, parentKey, ... }] }
    function loadMastodon(url) {
        var result = { source: 'mastodon', label: 'Mastodon', replyUrl: url, rootKey: '', ok: false, nodes: [] };
        var match = url.match(/^(https?:\/\/[^/]+)\/@[^/]+\/(\d+)$/);
        if (!match) return Promise.resolve(result);
        var instance = match[1];
        var statusId = match[2];
        result.rootKey = 'mastodon:' + statusId;

        return getJson(instance + '/api/v1/statuses/' + statusId + '/context')
            .then(function (data) {
                result.ok = true;
                (data.descendants || []).forEach(function (r) {
                    var acct = r.account;
                    result.nodes.push({
                        key: 'mastodon:' + r.id,
                        parentKey: 'mastodon:' + r.in_reply_to_id,
                        source: 'mastodon',
                        label: 'Mastodon',
                        name: acct.display_name || acct.username,
                        handle: '@' + acct.acct,
                        avatar: acct.avatar_static || acct.avatar || '',
                        profileUrl: acct.url,
                        url: r.url,
                        time: r.created_at,
                        html: r.content // sanitised HTML supplied by the Mastodon server
                    });
                });
                return result;
            })
            .catch(function () { return result; });
    }

    // ------------------------------------------------------------------- Bluesky

    // Accepts https://bsky.app/profile/<handle-or-did>/post/<rkey>
    // or at://<handle-or-did>/app.bsky.feed.post/<rkey>
    function parseBlueskyUrl(url) {
        var m = url.match(/^https:\/\/bsky\.app\/profile\/([^/]+)\/post\/([A-Za-z0-9]+)$/) ||
                url.match(/^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/([A-Za-z0-9]+)$/);
        return m ? { actor: m[1], rkey: m[2] } : null;
    }

    function loadBluesky(url) {
        var result = { source: 'bluesky', label: 'Bluesky', replyUrl: url, rootKey: '', ok: false, nodes: [] };
        var parsed = parseBlueskyUrl(url);
        if (!parsed) return Promise.resolve(result);
        result.replyUrl = 'https://bsky.app/profile/' + parsed.actor + '/post/' + parsed.rkey;

        var didPromise = parsed.actor.indexOf('did:') === 0
            ? Promise.resolve(parsed.actor)
            : getJson(BSKY_API + 'com.atproto.identity.resolveHandle?handle=' + encodeURIComponent(parsed.actor))
                .then(function (d) { return d.did; });

        return didPromise
            .then(function (did) {
                var uri = 'at://' + did + '/app.bsky.feed.post/' + parsed.rkey;
                result.rootKey = 'bluesky:' + uri;
                return getJson(BSKY_API + 'app.bsky.feed.getPostThread?depth=10&parentHeight=0&uri=' + encodeURIComponent(uri));
            })
            .then(function (data) {
                result.ok = true;
                walkBlueskyReplies(data.thread, result.rootKey, result.nodes);
                return result;
            })
            .catch(function () { return result; });
    }

    // Replies may also be notFoundPost / blockedPost entries: skip those (and,
    // implicitly, anything beneath them). Skip authors who have asked not to
    // be shown to logged-out viewers.
    function walkBlueskyReplies(thread, parentKey, out) {
        ((thread && thread.replies) || []).forEach(function (r) {
            if (r.$type !== 'app.bsky.feed.defs#threadViewPost' || !r.post) return;
            var post = r.post;
            var author = post.author || {};
            var hidden = (author.labels || []).some(function (l) { return l.val === '!no-unauthenticated'; });
            if (hidden) return;
            var key = 'bluesky:' + post.uri;
            var rkey = post.uri.split('/').pop();
            var record = post.record || {};
            out.push({
                key: key,
                parentKey: parentKey,
                source: 'bluesky',
                label: 'Bluesky',
                name: author.displayName || author.handle,
                handle: '@' + author.handle,
                avatar: author.avatar || '',
                profileUrl: 'https://bsky.app/profile/' + author.handle,
                url: 'https://bsky.app/profile/' + author.handle + '/post/' + rkey,
                time: record.createdAt || post.indexedAt,
                html: blueskyTextToHtml(record)
            });
            walkBlueskyReplies(r, key, out);
        });
    }

    function facetHref(features) {
        for (var i = 0; i < features.length; i++) {
            var f = features[i];
            if (f.$type === 'app.bsky.richtext.facet#link' && /^https?:\/\//.test(f.uri || '')) return f.uri;
            if (f.$type === 'app.bsky.richtext.facet#mention' && f.did) return 'https://bsky.app/profile/' + f.did;
            if (f.$type === 'app.bsky.richtext.facet#tag' && f.tag) return 'https://bsky.app/hashtag/' + encodeURIComponent(f.tag);
        }
        return '';
    }

    // Bluesky text is plain; links, mentions and tags are "facets" given as
    // UTF-8 byte ranges. Everything is escaped, so no raw HTML gets through.
    function blueskyTextToHtml(record) {
        var text = record.text || '';
        var bytes = new TextEncoder().encode(text);
        var decoder = new TextDecoder();
        var slice = function (a, b) { return decoder.decode(bytes.slice(a, b)); };
        var facets = (record.facets || []).filter(function (f) {
            return f.index && f.index.byteEnd > f.index.byteStart;
        }).sort(function (a, b) { return a.index.byteStart - b.index.byteStart; });

        var html = '';
        var pos = 0;
        facets.forEach(function (f) {
            var s = f.index.byteStart;
            var e = f.index.byteEnd;
            if (s < pos || e > bytes.length) return; // overlapping or out of range
            var label = escapeHtml(slice(s, e));
            var href = facetHref(f.features || []);
            html += escapeHtml(slice(pos, s));
            html += href
                ? '<a href="' + escapeHtml(href) + '" target="_blank" rel="noopener noreferrer">' + label + '</a>'
                : label;
            pos = e;
        });
        html += escapeHtml(slice(pos, bytes.length));
        return '<p class="comment-text-bluesky">' + html.replace(/\n/g, '<br>') + '</p>';
    }

    // ----------------------------------------------------------------- Rendering

    function timeOf(node) {
        var t = new Date(node.time).getTime();
        return isNaN(t) ? 0 : t;
    }

    // Top-level replies from all sources, oldest first, each followed
    // depth-first by its own replies (also oldest first).
    function flatten(results) {
        var children = {};
        var roots = [];
        results.forEach(function (res) {
            res.nodes.forEach(function (n) {
                (children[n.parentKey] = children[n.parentKey] || []).push(n);
            });
            roots = roots.concat(children[res.rootKey] || []);
        });

        var byTime = function (a, b) { return timeOf(a) - timeOf(b); };
        var out = [];
        var visit = function (node, depth) {
            out.push({ node: node, depth: depth });
            (children[node.key] || []).sort(byTime).forEach(function (c) { visit(c, depth + 1); });
        };
        roots.sort(byTime).forEach(function (n) { visit(n, 1); });
        return out;
    }

    function replyLinks(results, prefix) {
        var links = results.map(function (res) {
            return '<a href="' + escapeHtml(res.replyUrl) + '" target="_blank" rel="noopener noreferrer">' +
                   res.label + '</a>';
        });
        return prefix + ' ' + links.join(' or ');
    }

    function renderComment(item) {
        var n = item.node;
        var depth = Math.min(item.depth, 4);
        var profileUrl = escapeHtml(n.profileUrl);
        var html = '<li class="comment" data-depth="' + depth + '" data-source="' + n.source + '">';
        html +=   '<div class="comment-header">';
        html +=     '<a href="' + profileUrl + '" target="_blank" rel="noopener noreferrer" class="comment-avatar-link">';
        html +=       '<img src="' + escapeHtml(n.avatar) + '" alt="" class="comment-avatar" width="40" height="40">';
        html +=     '</a>';
        html +=     '<div class="comment-meta">';
        html +=       '<a href="' + profileUrl + '" target="_blank" rel="noopener noreferrer" class="comment-display-name">' + escapeHtml(n.name) + '</a>';
        html +=       '<span class="comment-handle">' + escapeHtml(n.handle) + '</span>';
        html +=     '</div>';
        html +=     '<span class="comment-source comment-source-' + n.source + '">' + n.label + '</span>';
        html +=     '<a href="' + escapeHtml(n.url) + '" target="_blank" rel="noopener noreferrer" class="comment-timestamp">' + relativeTime(n.time) + '</a>';
        html +=   '</div>';
        html +=   '<div class="comment-content">' + n.html + '</div>';
        html += '</li>';
        return html;
    }

    function render(results) {
        var section = document.getElementById('comments-section');
        if (!section) return;

        var failed = results.filter(function (r) { return !r.ok; });
        var items = flatten(results);
        var html = '';

        if (items.length === 0) {
            html = '<p class="comments-none">' +
                (failed.length === results.length ? 'Could not load replies. '
                    : failed.length ? 'No replies yet (could not load ' + failed[0].label + '). '
                    : 'No replies yet. ') +
                replyLinks(results, 'Reply on') + '</p>';
        } else {
            html = '<h3 class="comments-heading">Replies</h3><ul class="comments-list">' +
                items.map(renderComment).join('') + '</ul>';
            if (failed.length) {
                html += '<p class="comments-none">Could not load replies from ' +
                    failed.map(function (r) { return r.label; }).join(' or ') + '.</p>';
            }
            html += '<p class="comments-reply-links">' + replyLinks(results, 'Reply on') + '</p>';
        }
        section.innerHTML = html;
    }
}());
