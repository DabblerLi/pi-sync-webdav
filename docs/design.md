# Design

## Scope

`pi-sync-webdav` is a Pi Package for manual configuration sync over one Basic Auth WebDAV connection.

- Commands: `/sync-webdav`, `setup`, `status`, `diff`, `push`, `pull`, and `restore`.
- Sync is always user initiated. There is no background sync, file watching, multi-target support, ETag/LOCK handling, remote history, or backward compatibility.
- The plugin supports standard WebDAV operations only: `MKCOL`, `PROPFIND`, `GET`, `PUT`, and `DELETE`.

## Private local state

Private data lives under the effective Pi agent directory in `pi-sync-webdav/` and is never synced.

- Configuration and credentials use mode `0600` where supported.
- `backups/` contains the latest local backup per affected file.
- A local temporary workspace is used for downloads before local replacement.
- The configuration stores one connection, the push include list, minimal sync state, and an optional pending package-operation queue containing only an action and package source.
- Sync state contains only a connection fingerprint and managed relative paths. It is used to safely mirror remote deletions only for files previously managed by the same connection.

## Remote layout

The user-configured remote path is an exclusive plugin root:

```text
<remote root>/
├── manifest.json
└── revisions/
    └── <random revision ID>/
        └── <complete active file set>
```

`manifest.json` contains the current format version, one lowercase UUID-v4 revision ID, and each file's relative path, SHA-256, and size.

A push uploads a complete new revision, rechecks the current manifest hash, and writes `manifest.json` last. A revision is not active until referenced by the manifest. After a verified commit, the previous current-format revision is removed. There is no remote restore history.

If a manifest is unsupported, malformed, or otherwise invalid, pull rejects it. Push can overwrite it only after an explicit risk confirmation and never migrates or deletes its legacy data.

## Sync behavior

- The local include list affects push only. Pull always applies the remote manifest.
- Every push and pull presents one batch confirmation using file paths and add/update/delete actions.
- Pull downloads and verifies every file before replacing local files. Local backups are created before overwrites or managed-file deletions.
- Pull deletes only paths recorded in matching local sync state that are absent from the current manifest. First pull or a changed connection never deletes local files.
- Cancelling or failing an operation leaves active local and remote versions intact where possible. A revision may be deleted only after verifying that the current manifest does not reference it.
- `restore` restores local backups only.

`settings.json` package declarations are applied after pull with Pi's package manager: added packages install, removed packages uninstall, and changed npm versions or Git refs update. If a package operation fails, pulled files remain and a minimal retry queue is persisted.

## Safety rules

- Validate URLs, remote paths, manifest entries, and local targets before I/O. A remote path may have one input trailing slash but is persisted without it. Reject unsafe paths, special files, Windows absolute/drive paths, and symlink traversal.
- `npm/`, `git/`, and the plugin private directory are never synced.
- `sessions/` and `auth.json` are opt-in with extra confirmation. `auth.json` is restored with mode `0600`.
- Selected text files receive local secret-pattern warnings. Secrets, credentials, file contents, and Authorization headers are never rendered or logged.
- HTTPS is required by default; HTTP requires explicit confirmation. Invalid or self-signed TLS certificates are rejected.
- Limits: 50 MiB per file and 500 MiB per operation.

## Verification

- Unit and integration tests use Vitest.
- The integration fixture is a local `node:http` WebDAV server; Docker and vendor-specific CI are intentionally excluded.
- Ubuntu runs the complete Node 22/24 matrix. Windows and macOS run type, unit, and sensitive-permission checks.
- The public README is English with a Chinese translation. Development documentation and contributor guidance are English.
