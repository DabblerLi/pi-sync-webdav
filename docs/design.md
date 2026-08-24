# Design

## Scope

`pi-sync-webdav` is a Pi Package for manual configuration sync over one Basic Auth WebDAV connection.

- Commands: `/sync-webdav`, `settings`, `status`, `diff`, `push`, `pull`, `restore`, and `cleanup`.
- `/sync-webdav` initializes an unconfigured package; otherwise its dashboard offers routine commands. `cleanup` remains available only as an explicit subcommand. `settings` edits either the complete connection or the local push selection. Saving a connection validates read and write access but does not start a push or pull.
- Sync is always user initiated. There is no background sync, file watching, multi-target support, ETag/LOCK handling, remote history, or backward compatibility.
- The plugin supports standard WebDAV operations only: `COPY`, `MKCOL`, `PROPFIND`, `GET`, `PUT`, and `DELETE`.

## Private local state

Private data lives under the effective Pi agent directory in `pi-sync-webdav/` and is never synced.

- Configuration and credentials use mode `0600` where supported. A pull repairs `auth.json` to mode `0600` where supported even when its contents are unchanged.
- `backups/` holds the files replaced or removed by the most recent pull that changed local files; the first backup write of a later pull replaces the previous set.
- A local temporary workspace stages downloads for verification before local replacement. It is removed when the pull finishes, and stale workspaces from interrupted pulls are removed when the next pull starts.
- The configuration stores one connection, the push include list, and minimal sync state.
- Sync state contains only a connection fingerprint and managed relative paths. It is used to safely mirror remote deletions only for files previously managed by the same connection.
- Saving a connection with a changed URL, remote path, or username drops sync state; changing only the password retains it.

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

A push creates a complete new revision. When a current revision exists, unchanged files are reused by copying their top-level files or directories under the new revision; only changed files are uploaded. When the server rejects a top-level `COPY` with a definite HTTP status, that entry is removed and rebuilt by uploading its complete file set, and the substitution is reported. Authentication failures, missing source revisions, and unclear outcomes remain fatal; a `405` or `501` rejection also stops remaining `COPY` attempts for the same push. The current manifest hash is rechecked before `manifest.json` is written last. A revision is not active until referenced by the manifest. After a verified commit, the previous current-format revision is removed. Failed cleanup or uncertain activation is surfaced in the current interaction. Explicit cleanup revalidates the manifest before deleting only recognized inactive plugin residue; unknown items are retained.

If a manifest is unsupported, malformed, or otherwise invalid, pull rejects it. Push can overwrite it only after an explicit risk confirmation and never migrates or deletes its legacy data.

## Sync behavior

- The local include list affects push only. Pull always applies the remote manifest.
- Only files listed in the manifest are materialized; absent or empty directories are not created by pull.
- Pushes and pulls with changes present one batch confirmation using file paths and add/update/delete actions. A permission-only `SECURE auth.json` action is also confirmed. The plan list scrolls inside the dialog with j/k and page keys, and warnings stay pinned above the confirm options.
- Pull downloads and verifies only added or updated files before replacing local files. Unchanged files, deletions, and permission-only repairs require no file download. Local backups are created before overwrites or managed-file deletions.
- Pull deletes only paths recorded in matching local sync state that are absent from the current manifest. First pull or a changed connection never deletes local files.
- Independent file reads, validation, uploads, and downloads run with a concurrency limit of four. Manifest activation, backups, local application, and rollback remain serial.
- Interactive connection validation, push, pull, restore, and cleanup report safe phase and retry progress. Esc requests cancellation at supported network and file boundaries; staging cleanup and remote commit verification complete before the interaction finishes.
- Cancelling or failing an operation leaves active local and remote versions intact where possible. A revision may be deleted only after verifying that the current manifest does not reference it.
- `restore` restores local backups only.

`settings.json` package declarations are applied after pull with Pi's package manager: added packages install, removed packages uninstall, and changed npm versions or Git refs update. If a package operation fails or cancellation interrupts reconciliation, pulled files remain, `syncState` is not persisted, and Pi reports that manual action is required.

## Safety rules

- Validate URLs, remote paths, manifest entries, and local targets before I/O. A remote path may have one input trailing slash but is persisted without it; the remote path is required and re-prompted immediately when invalid. Reject unsafe paths: traversal, special files, absolute/Windows paths, device names, alternate data streams, trailing dots/spaces, symlinks, and case-insensitive collisions.
- Top-level `npm/`, `git/`, and the plugin private directory are never synced. `logs/` and `node_modules/` are excluded at every depth.
- `sessions/` and `auth.json` are opt-in. The extra confirmation appears when such a path is added to the push selection and is remembered while it remains selected; removing it and adding it again requires confirmation again. `auth.json` is restored with mode `0600`.
- Selected text files receive local secret-pattern warnings. Secrets, credentials, file contents, and Authorization headers are never rendered or logged.
- HTTPS is required by default; HTTP requires explicit confirmation. Invalid or self-signed TLS certificates are rejected. A connection must prove read access before it can be saved; a failed write probe produces an explicitly read-only connection.
- Limits: 50 MiB per file and 500 MiB per operation.

## Verification

- Unit and integration tests use Vitest. The fixture is an in-process `node:http` Basic Auth WebDAV server; Docker and vendor-specific CI are intentionally excluded.
- CI runs tests on Ubuntu (Node 22 and 24), macOS, and Windows; static and package checks run once on Ubuntu with Node 24. Tag publishing requires the same commit to have passed CI on `main`; see [.github/workflows](../.github/workflows).
