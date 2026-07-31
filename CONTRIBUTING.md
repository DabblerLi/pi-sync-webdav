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

## Where to change

| Area                                                   | Source                             | Tests                            |
| ------------------------------------------------------ | ---------------------------------- | -------------------------------- |
| Command routing, interactive policy, dashboards        | `src/commands.ts`                  | `test/commands.test.ts`          |
| TUI dialogs, password prompt, progress loader          | `src/ui.ts`, `src/secret-input.ts` | `test/ui.test.ts`                |
| WebDAV client, error sanitization, retries             | `src/webdav.ts`                    | `test/webdav.test.ts`            |
| Remote roots, manifest, revisions, residue cleanup     | `src/remote-store.ts`              | `test/remote-store.test.ts`      |
| Push/pull preparation, staging, package reconciliation | `src/sync-service.ts`              | `test/sync-service.test.ts`      |
| Local workspace, backups, restore                      | `src/local-transaction.ts`         | `test/local-transaction.test.ts` |
| Local file selection, secret scanning                  | `src/selection.ts`                 | `test/selection.test.ts`         |
| Path validation, exclusions                            | `src/paths.ts`                     | `test/paths.test.ts`             |
| Pi package source planning                             | `src/package-sync.ts`              | `test/package-sync.test.ts`      |

Read [`docs/design.md`](docs/design.md) before changing synchronization behavior; update it in the same change when the behavior contract changes.

## Tests

Add focused Vitest coverage for new behavior and failure paths. The fixture is an in-process Basic Auth WebDAV server (`test/mock-webdav-server.ts`).

When changing package, file, network, or transaction behavior, cover both the successful path and the relevant failure or cancellation path.

## Documentation

Keep contributor and design documentation in English. Maintain `README.md` as the English source and update `README.zh-CN.md` as its Chinese translation whenever user-facing behavior changes.
