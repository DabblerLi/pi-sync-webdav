# pi-sync-webdav

[简体中文](README.zh-CN.md)

Manual, single-target synchronization for one Pi Coding Agent configuration directory through a Basic Auth WebDAV server. It does not perform automatic background sync or retain remote history.

## Requirements

- Pi Coding Agent
- A WebDAV endpoint that supports Basic Auth
- HTTPS, unless you explicitly accept the HTTP warning during setup

## Install

Install it globally:

```bash
pi install npm:pi-sync-webdav
```

Use Pi's package updater to install the newest published package version:

```bash
pi update --extensions
```

Pi packages run code with your user permissions. Review the source before installing from an untrusted publisher.

## Commands

| Command                | Purpose                                                             |
| ---------------------- | ------------------------------------------------------------------- |
| `/sync-webdav`         | Opens setup when unconfigured, otherwise opens the dashboard.       |
| `/sync-webdav setup`   | Configures the WebDAV connection and push selection.                |
| `/sync-webdav status`  | Checks remote readability without modifying local or remote state.  |
| `/sync-webdav diff`    | Shows planned push changes without modifying local or remote state. |
| `/sync-webdav push`    | Uploads the selected local configuration.                           |
| `/sync-webdav pull`    | Downloads and applies remote configuration after confirmation.      |
| `/sync-webdav restore` | Restores the latest local backups created by a prior pull.          |

`setup`, `push`, `pull`, and `restore` require an interactive Pi TUI. `status` and `diff` are the only non-interactive commands.

## Setup

Run:

```text
/sync-webdav setup
```

The wizard asks for:

1. WebDAV URL
2. Plugin-specific remote path
3. Basic Auth username
4. Basic Auth password
5. Local push selection

Use a dedicated remote path for this package. Setup rejects a non-empty remote root that lacks `manifest.json` instead of modifying unrelated files.

Setup verifies directory access and all required write operations. A readable connection that cannot create, upload, read, and delete a probe resource is stored as read-only: `status`, `diff`, and `pull` remain available, while `push` is disabled.

## What is synchronized

The default push selection includes:

- `settings.json`
- `keybindings.json`
- `AGENTS.md`
- `SYSTEM.md`
- `APPEND_SYSTEM.md`
- `models.json`
- `themes/`
- `prompts/`
- `skills/`
- `extensions/`

The setup selector can include other safe top-level files and directories. Directories are recursive. `npm/`, `git/`, and this package's private state are always excluded. `sessions/` and `auth.json` are opt-in and require an additional confirmation. `auth.json` is restored with owner-only permissions where the platform supports them.

Before a push, text files are checked locally for common secret patterns. The UI reports only affected paths; it never displays detected content.

## Sync behavior

### Push

A push uploads a complete remote snapshot and activates it only after the upload completes. If the remote changes before activation, run push again.

### Pull

After one batch confirmation, pull validates the complete download before changing local files. It backs up files it overwrites or safely removes.

The first pull never deletes local files merely because they are absent remotely. Deletions are limited to paths previously managed by the same configured connection.

### Pi packages

`settings.json` package declarations are reconciled after files apply. Added packages install, removed packages uninstall, and changed npm or Git sources are reinstalled. Pi's `npm/` and `git/` caches are not synchronized. Failed package actions are retried on a later pull without reverting pulled files.

## Security model

- WebDAV URLs cannot contain embedded credentials, query parameters, or fragments.
- Passwords, Authorization headers, file contents, and secret-pattern matches are not shown in UI messages or error text.
- Remote and local paths are validated before I/O. Symbolic links and unsafe file types are not synchronized.
- Private configuration, credentials, backups, and pull workspaces live under `pi-sync-webdav/` inside the effective Pi agent directory and are never synchronized.
- Pulls and restores use local-only backups. There is no remote restore operation or remote history.
- Press Esc during a pull download to cancel it; the temporary workspace is cleaned when possible.

## Development

Development requires Node.js 22.19 or later and npm.

```bash
npm ci
npm run format:check
npm run lint
npm run typecheck
npm test
npm run pack:check
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines.

## License

[MIT](LICENSE)
