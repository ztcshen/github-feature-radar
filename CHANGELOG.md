# Changelog

## 0.2.0

- Add help and version commands; running the CLI without arguments shows help and leaves inventory untouched. Refresh now requires an explicit command.
- Validate command-specific options and numeric limits before file or network access, with usage errors reported as exit code 2.
- Add --data-dir for a coherent writable inventory/Markdown/index directory when using an installed CLI. Explicit paths take precedence independently of argument order.

## 0.1.1

- Run offline tests, inventory policy checks, coverage checks, and package validation for every main-branch push and pull request on Node.js 22 and 24.
- Include the Apache-2.0 license and an explicit, self-contained CLI package file list.
- Keep the daily inventory refresh separate from code validation and serialize refresh runs to protect generated data updates.

## 0.1.0

- Feature-first GitHub discovery with star, activity, archive, and fork policy checks.
- Searchable feature terms, fuzzy suggestions, and full reference counts beyond the displayed top matches.
- Inventory freshness, audit, coverage, and daily automated refresh commands.
