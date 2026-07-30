# Project guide

Read `docs/design.md` before changing implementation code. Treat the following as the current design, and revisit them when a task explicitly changes the product scope.

## Current design

- The package currently supports one manually initiated Basic Auth WebDAV target.
- Pushes publish a complete new revision and activate it through `manifest.json`.
- Local backups, safe pull deletion based on matching `syncState`, path validation, and symlink protection are part of the current safety model.
- `npm/`, `git/`, and `pi-sync-webdav/` are excluded from synchronization under the current design. `logs/` and `node_modules/` directories are also excluded at every depth.

## Implementation expectations

- Keep credentials and secret matches out of UI, errors, logs, and manifests. Reject credential-bearing package sources before display or persistence.
- Keep `status` and `diff` read-only. Pull cancellation should clean its private workspace.
- Reconcile `settings.packages` through Pi's exported `SettingsManager` and `DefaultPackageManager`.
- Add focused Vitest coverage for behavior, failures, and cancellation paths.

## Public delivery

- Write public documentation for readers: avoid future plans, process narration, unnecessary implementation detail, and backward-compatibility discussion.
- `README.md` is English and `README.zh-CN.md` is its Chinese translation; both link to the other language at the top.
- The current delivery uses tag-triggered npm publishing through `.github/workflows/publish.yml` and does not include GitHub Releases, Changesets, or a changelog.

## Validation and Git

- Before reporting completion, run formatting, lint, typecheck, tests, package validation, and `git diff --check`.
- Do not commit, publish, change versions, push tags, or alter release settings without explicit user approval. Review the diff before staging.
