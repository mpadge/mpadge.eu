#!/usr/bin/make
BLOG=2026-10-04-coding-alone

.PHONY: help start serve install code rss update publish bluesky hooks check blog% render build test deploy upgrade tidycheck

help: ## Show this help
	@printf "Usage:\033[36m make [target]\033[0m\n"
	@grep -E '^[a-zA-Z_%_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}'
	@printf "\n\033[36mWorkflow for a new post or note (order matters):\033[0m\n"
	@printf "  1. make blog         render the post (or 'make render' for BLOG)\n"
	@printf "  2. make update       local: blog and notes data, RSS, llms.txt\n"
	@printf "  3. make publish      atproto records; writes src/atproto.json\n"
	@printf "     make publish POST=<slug>  also create the PUBLIC Bluesky post (comment thread) for that blog post\n"
	@printf "     make publish NOTE=<slug>  same, for a note (post text = title + description, max 300 characters;\n"
	@printf "                               add TEXT=\"...\" to write your own text instead)\n"
	@printf "     make bluesky         instead, if you posted on Bluesky by hand: finds and links your post\n"
	@printf "  4. git commit        include src/atproto.json and all updated files\n"
	@printf "  5. git push          codeberg webhook builds and deploys the site\n"
	@printf "\nManual deploy instead of step 5: 'make build' then 'make deploy'.\n"
	@printf "src/atproto.json must be current BEFORE the build, so never build or deploy before 'make publish'.\n"

.DEFAULT_GOAL := help

start: serve

serve: ## Start development server (same as 'start')
	yarn start

install: ## Install everything to run/build
	yarn install

code: ## Update the 'code' section from current r-univ pkgs list
	Rscript 'tools/code-update.R'

rss: ## Update RSS XML feed
	Rscript 'tools/blog/make_rss.R'

update: ## Update blog index, notes data, RSS XML feed, and llms.txt (local only)
	Rscript -e 'source("tools/blog/update_main.R")'
	node --input-type=module -e 'import { writeNotesShort, writeNotesData } from "./tools/notesPages.js"; await writeNotesShort (); console.log ("✔ Updated src/data/notesshort.yml"); await writeNotesData (); console.log ("✔ Updated src/data/notes.yml")'
	node --input-type=module -e 'import { updateLlmsTxt } from "./tools/llmsTxt.js"; await updateLlmsTxt ()'

# TEXT=... reaches publish.mjs through the environment, so quotes in it are safe
export ANNOUNCE_TEXT := $(TEXT)

publish: ## Publish atproto records; add POST=<slug> or NOTE=<slug> (and optional TEXT=...) to also announce on Bluesky
	@export ATPROTO_APP_PASSWORD="$${ATPROTO_APP_PASSWORD:-$$(pass show atproto/app-password 2>/dev/null | head -n1)}"; \
	if [ -n "$$ATPROTO_APP_PASSWORD" ]; then \
		ATPROTO_IDENTIFIER=mpadge.eu node tools/atproto/publish.mjs --publish $(if $(POST),--announce=$(POST)) $(if $(NOTE),--announce-note=$(NOTE)); \
	else \
		echo "Cannot publish atproto records: set ATPROTO_APP_PASSWORD or add atproto/app-password to pass" >&2; \
		exit 1; \
	fi

bluesky: ## Link Bluesky posts made by hand (auto-find them, or POST=/NOTE=<slug> BSKY=<post URL>)
	node tools/atproto/link-bluesky.mjs $(if $(POST),--post=$(POST)) $(if $(NOTE),--note=$(NOTE)) $(if $(BSKY),--url='$(BSKY)')

hooks: ## Enable the versioned git hooks in .githooks (checks atproto records before commit)
	git config core.hooksPath .githooks

check: ## Check that src/atproto.json covers all posts and notes
	node tools/check-atproto.mjs

blog: ## Render latest blog post (or hard-code value in 'tools/blog/update_one.R')
	Rscript -e 'source("tools/blog/update_one.R")'

render: ## Render $(BLOG) to gfm .md from .qmd or .Rmd (no-op if only .md)
	@f=src/pages/blog/$(BLOG); \
	if [ -f "$$f.qmd" ]; then \
		cp "$$f.md" "$$f.md.prev" 2>/dev/null || true; \
		quarto render "$$f.qmd" --to gfm && \
		Rscript tools/qmd-figures.R "$$f.md" "$$f.md.prev"; \
		rm -f "$$f.md.prev"; \
	elif [ -f "$$f.Rmd" ]; then \
		Rscript -e 'rmarkdown::render("'"$$f.Rmd"'", output_format = rmarkdown::md_document(variant = "gfm"))'; \
	else \
		echo "No .qmd or .Rmd source for $(BLOG); nothing to render"; \
	fi

build: ## Build the project
	yarn build

test: ## Run tests
	yarn test

deploy: ## Publish the site on statichost.eu
	@bash tools/deploy.sh

upgrade: ## Upgrade yarn dependencies. Use 'yarn upgrade-interactive --latest' for major upgrades
	yarn upgrade

tidycheck: ## Check HTML files with tidy and show warnings with context
	bash tools/tidy-check.sh
