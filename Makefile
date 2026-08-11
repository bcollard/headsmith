# ============================================================
#  Headsmith — developer entry points
#
#  Thin wrappers over the npm scripts, kept because `make help`
#  answers "what can I do here?" in one line and package.json
#  does not.
# ============================================================

.DEFAULT_GOAL := help

.PHONY: help
help:            ## Show this help
	@grep -E '^[a-zA-Z0-9_-]+:.*##' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*##"}; {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

.PHONY: install
install:         ## Install dependencies from the lockfile
	npm ci

.PHONY: dev
dev:             ## Run the extension in development mode with hot reload
	npm run dev

.PHONY: build
build:           ## Build the unpacked extension into dist/chrome
	npm run build

.PHONY: icons
icons:           ## Regenerate every icon and store asset from scripts/lib/logo.mjs
	npm run icons

.PHONY: test
test:            ## Unit tests
	npm test

.PHONY: e2e
e2e:             ## End-to-end tests against a real loaded extension (builds first)
	npm run test:e2e

.PHONY: guard
guard:           ## Run the invariant guards against dist/ (build first)
	npm run guard

.PHONY: check
check: 		 ## Everything CI runs, in the same order
	npm run typecheck && npm run lint && npm run test:coverage && \
	npm run icons -- --check && npm run build && npm run guard

.PHONY: load
load:            ## Open chrome://extensions so dist/chrome can be loaded unpacked
	@open -a "Google Chrome" "chrome://extensions" 2>/dev/null || \
	 google-chrome "chrome://extensions" 2>/dev/null || \
	 echo "Open chrome://extensions and load dist/chrome as an unpacked extension."

.PHONY: clean
clean:           ## Remove build output and caches
	rm -rf dist .wxt coverage playwright-report test-results
	@echo "Cleaned."
