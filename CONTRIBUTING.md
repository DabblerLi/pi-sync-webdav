# Contributing

## Prerequisites

- Node.js 22.19 or later
- npm

## Local setup

```bash
git clone https://github.com/DabblerLi/pi-sync-webdav.git
cd pi-sync-webdav
npm ci
```

## Required checks

Run all checks before opening a pull request:

```bash
npm run format:check
npm run lint
npm run typecheck
npm test
npm run pack:check
```

## Scope and design rules

Read [`docs/design.md`](docs/design.md) before changing implementation code.

Preserve the project's core behavior:

- Support one Basic Auth WebDAV target and manual synchronization only.
- Publish complete remote revisions; do not overwrite an active revision in place.
- Never synchronize `npm/`, `git/`, or the package's private state.
- Preserve safe pull deletion, local-only backups, symlink protection, path validation, and secret redaction.

## Tests

Add focused Vitest coverage for new behavior and failure paths. The test fixture is an in-process Basic Auth WebDAV server.

When changing package, file, network, or transaction behavior, cover both the successful path and the relevant failure or cancellation path.

## Documentation

Keep public documentation in English. Update `README.zh-CN.md` whenever the user-facing README changes so it remains a Chinese translation of the same behavior.

Do not add credentials, private configuration, local backups, or other machine-local files to a pull request.
