#!/usr/bin/env Rscript
#
# Post-process a blog post rendered from .qmd to gfm, so that it works as a
# page of this site. Called by `make render` after `quarto render`. Usage:
#
#   Rscript tools/qmd-figures.R <post.md> [<previous-post.md>]
#
# Both arguments are paths to the rendered .md. The second is a copy of the
# .md taken before rendering, from which the site's YAML front matter is
# restored (quarto's gfm output drops it, and it is not part of the .qmd).
#
# Changes made to the rendered .md:
# 1. Figures: quarto's `<div id="fig-x"><img src="<slug>-figures/..."> ...`
#    become `<figure>` elements pointing to /assets/img/<slug>/, with the same
#    structure as other figures on the site, and with alt text taken from the
#    caption.
# 2. References: in-text citations are linked to their entries in the
#    reference list (needs `link-citations: true` in the .qmd), and all bare
#    URLs in the reference list are made explicit hyperlinks.
# 3. Quarto boilerplate (title block, source comment, unused <style>) removed.

args <- commandArgs (trailingOnly = TRUE)
if (length (args) < 1L) {
    stop ("Usage: qmd-figures.R <post.md> [<previous-post.md>]")
}
md_file <- args [1]
prev_file <- if (length (args) > 1L) args [2] else NULL

# Image dir is derived from file name, dropping the date prefix:
slug <- sub ("^[0-9]{4}-[0-9]{2}-[0-9]{2}-", "", tools::file_path_sans_ext (basename (md_file)))
img_dir <- paste0 ("/assets/img/", slug, "/")

x <- paste0 (readLines (md_file, warn = FALSE), collapse = "\n")

# ---- front matter ----
get_front <- function (f) {
    if (is.null (f) || !file.exists (f)) {
        return ("")
    }
    lines <- readLines (f, warn = FALSE)
    if (length (lines) == 0L || lines [1] != "---") {
        return ("")
    }
    end <- which (lines == "---") [2]
    if (is.na (end)) {
        return ("")
    }
    paste0 (c (lines [1:end], "", ""), collapse = "\n")
}
front <- get_front (prev_file)

# ---- boilerplate ----
# Title block: "# Title\nAuthor\nDate", kept as title only
x <- sub ("^(# [^\n]*)\n[^\n]*\n[0-9-]{10}\n", "\\1\n", x)
x <- gsub ("(?s)<!--.*?-->\\s*", "", x, perl = TRUE)
x <- gsub ("(?s)<style>.*?</style>\\s*", "", x, perl = TRUE)

# ---- figures ----
esc_html <- function (s) {
    s <- gsub ("&", "&amp;", s, fixed = TRUE)
    s <- gsub ("\"", "&quot;", s, fixed = TRUE)
    gsub ("<", "&lt;", s, fixed = TRUE)
}

fig_html <- function (id, src, caption) {
    # pandoc uses non-breaking spaces in "Figure N:"
    caption <- gsub ("\u00a0", " ", caption)
    img <- paste0 (img_dir, basename (src))
    alt <- sub ("^Figure [0-9]+: *", "", gsub ("\\s+", " ", caption))
    alt <- esc_html (sub ("([.?!]) .*$", "\\1", alt)) # first sentence only
    cap <- paste0 ("        ", gsub ("\n", "\n        ", caption))
    paste0 (
        "<figure class=\"blog-figure\" id=\"", id, "\">\n",
        "    <picture>\n",
        "        <source media=\"(min-width: 640px)\" srcset=\"", img, "\">\n",
        "        <img\n",
        "            src=\"", img, "\"\n",
        "            alt=\"", alt, "\"\n",
        "            loading=\"lazy\">\n",
        "    </picture>\n",
        "    <figcaption>\n", cap, "\n    </figcaption>\n",
        "</figure>"
    )
}

pat <- paste0 (
    "(?s)<div id=\"(fig-[^\"]+)\">\\s*",
    "<img src=\"([^\"]+)\"[^>]*/>\\s*",
    "(Figure[^0-9]{1,3}[0-9]+:.*?)\\s*</div>"
)
m <- gregexec (pat, x, perl = TRUE)
if (length (regmatches (x, m) [[1]]) > 0L) {
    parts <- regmatches (x, m) [[1]] # character matrix: row 1 = whole match
    for (i in seq_len (ncol (parts))) {
        new <- fig_html (parts [2, i], parts [3, i], parts [4, i])
        x <- sub (parts [1, i], new, x, fixed = TRUE)
    }
    n_fig <- ncol (parts)
} else {
    n_fig <- 0L
}
message ("qmd-figures: converted ", n_fig, " figures")

# ---- references ----
# Wrap bare autolinks <https://...> in the reference list as explicit links:
refs_start <- regexpr ("<div id=\"refs\"", x, fixed = TRUE)
if (refs_start > 0L) {
    head <- substr (x, 1L, refs_start - 1L)
    tail <- substr (x, refs_start, nchar (x))
    tail <- gsub ("<(https?://[^>\\s]+)>", "[\\1](\\1)", tail, perl = TRUE)
    x <- paste0 (head, tail)
}

# Every citation key in the text should now be a link to an existing entry
cites <- unique (regmatches (x, gregexpr ("\\(#ref-[A-Za-z0-9_:.-]+\\)", x)) [[1]])
cites <- gsub ("^\\(#|\\)$", "", cites)
defined <- regmatches (x, gregexpr ("<div id=\"(ref-[^\"]+)\"", x)) [[1]]
defined <- gsub ("^<div id=\"|\"$", "", defined)
missing <- setdiff (cites, defined)
if (length (missing) > 0L) {
    warning ("qmd-figures: citations without reference entry: ",
        paste0 (missing, collapse = ", "))
}
if (length (cites) == 0L && length (defined) > 0L) {
    warning ("qmd-figures: no linked citations; is `link-citations: true` ",
        "set in the .qmd?")
}
message ("qmd-figures: ", length (cites), " linked citations, ",
    length (defined), " references")

writeLines (paste0 (front, x, "\n"), md_file, sep = "")
