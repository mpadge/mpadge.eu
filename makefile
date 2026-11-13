#!/usr/bin/make
BLOG=2026-10-04-coding-alone

.PHONY: help start serve install code blog% render build test tidycheck

help: ## Show this help
	@printf "Usage:\033[36m make [target]\033[0m\n"
	@grep -E '^[a-zA-Z_%_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}'

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

update: ## Update blog index, RSS XML feed, llms.txt, and atproto records
	Rscript -e 'source("tools/blog/update_main.R")'
	node --input-type=module -e 'import { updateLlmsTxt } from "./tools/llmsTxt.js"; await updateLlmsTxt ()'
	@if [ -n "$$ATPROTO_APP_PASSWORD" ]; then \
		ATPROTO_IDENTIFIER=$${ATPROTO_IDENTIFIER:-mpadge.eu} node tools/atproto/publish.mjs --publish; \
	else \
		echo "Skipping atproto records: set ATPROTO_APP_PASSWORD to publish them"; \
	fi

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
