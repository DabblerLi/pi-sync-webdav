# AGENTS.md

Read `docs/design.md` before changing code.

- Keep one manual Basic Auth WebDAV connection. Do not add auto-sync, multiple targets, ETag/LOCK, remote history, object storage, or compatibility/migration code.
- Preserve the `manifest.json` → complete immutable revision transaction. Never overwrite the active revision in place.
- Keep local-only backups, safe pull deletion via matching `syncState`, path validation, symlink protection, and secret redaction.
- Use Pi's exported `SettingsManager` and `DefaultPackageManager` for `settings.packages`; do not sync `npm/` or `git/`.
- Before staging, ensure private configuration, backups, workspaces, generated agent artifacts, and local planning notes are not staged or published.
- Add focused Vitest coverage for behavior and failure paths. Run relevant tests, lint, typecheck, and formatting before reporting completion.
- Keep public documentation in English; `README.zh-CN.md` is the Chinese README translation.
- Do not commit, publish, change versions, or modify release settings without explicit user approval.
