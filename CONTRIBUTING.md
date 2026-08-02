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
git diff --check
```

## Code map

| Area                                     | Source                                                 | Tests                                                                    |
| ---------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------ |
| Commands, interaction, and TUI           | `src/commands.ts`, `src/ui.ts`, `src/secret-input.ts`  | `test/commands.test.ts`, `test/ui.test.ts`                               |
| Operation lifecycle and concurrency      | `src/operation.ts`                                     | `test/operation.test.ts`                                                 |
| WebDAV transport and remote revisions    | `src/webdav.ts`, `src/remote-store.ts`                 | `test/webdav.test.ts`, `test/remote-store.test.ts`                       |
| Selection, planning, and path safety     | `src/selection.ts`, `src/sync-plan.ts`, `src/paths.ts` | `test/selection.test.ts`, `test/sync-plan.test.ts`, `test/paths.test.ts` |
| Local staging, backups, and restore      | `src/local-transaction.ts`, `src/safe-files.ts`        | `test/local-transaction.test.ts`                                         |
| Package reconciliation and orchestration | `src/package-sync.ts`, `src/sync-service.ts`           | `test/package-sync.test.ts`, `test/sync-service.test.ts`                 |
| Configuration and manifest schemas       | `src/config.ts`, `src/manifest.ts`                     | `test/config.test.ts`, `test/manifest.test.ts`                           |

Read [`docs/design.md`](docs/design.md) before changing synchronization behavior; update it in the same change when the behavior contract changes.

## Tests

Add focused Vitest coverage for new behavior and its relevant failure or cancellation paths. Integration tests use the in-process Basic Auth WebDAV server in `test/mock-webdav-server.ts`.

## Documentation

Keep contributor and design documentation in English. Maintain `README.md` as the English source and update `README.zh-CN.md` as its Chinese translation whenever user-facing behavior changes.
