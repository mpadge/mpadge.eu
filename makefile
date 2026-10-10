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

update: ## Update blog index and RSS XML feed
	Rscript -e 'source("tools/blog/update_main.R")'

blog: ## Render latest blog post (or hard-code value in 'tools/blog/update_one.R')
	Rscript -e 'source("tools/blog/update_one.R")'

render: ## Render $(BLOG) to gfm .md from .qmd or .Rmd (no-op if only .md)
	@f=src/pages/blog/$(BLOG); \
	if [ -f "$$f.qmd" ]; then \
		quarto render "$$f.qmd" --to gfm; \
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

tidycheck: ## Check HTML files with tidy and show warnings with context
	bash tools/tidy-check.sh
