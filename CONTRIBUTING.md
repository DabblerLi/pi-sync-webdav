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

## Design context

[`docs/design.md`](docs/design.md) describes the current behavior and is useful background for implementation changes. Update it when a change alters product behavior.

## Tests

Add focused Vitest coverage for new behavior and failure paths. The test fixture is an in-process Basic Auth WebDAV server.

When changing package, file, network, or transaction behavior, cover both the successful path and the relevant failure or cancellation path.

## Documentation

Keep public documentation in English. Update `README.zh-CN.md` whenever the user-facing README changes so it remains a Chinese translation of the same behavior.

Do not add credentials, private configuration, local backups, or other machine-local files to a pull request.
