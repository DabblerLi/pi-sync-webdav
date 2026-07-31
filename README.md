# pi-sync-webdav

[简体中文](README.zh-CN.md)

A Pi Coding Agent extension that syncs one configuration directory to and from a WebDAV server using Basic Auth.

Sync is manual and one direction at a time: you run `push` or `pull` yourself. There is no background sync, no multi-target routing, and no remote history to restore from.

## Requirements

- Pi Coding Agent
- A WebDAV server that supports Basic Auth
- HTTPS (HTTP is allowed only after you accept the cleartext warning during setup)

## Install

```bash
pi install npm:pi-sync-webdav
```

Update with:

```bash
pi update --extensions
```

## Quick start

1. Create an empty, dedicated WebDAV folder for pi-sync-webdav. Do not put other files in it; the extension manages its own sync data there.
2. Run `/sync-webdav` and enter the WebDAV URL, the folder path, your username, and password. Setup will test read and write access to this folder before saving.
3. Choose which local paths to push.
4. Run `push` on the machine you want to sync from and `pull` on the machine you want to sync to. Each changing action asks for confirmation first.

## Commands

| Command                 | What it does                                                                    |
| ----------------------- | ------------------------------------------------------------------------------- |
| `/sync-webdav`          | Opens setup when unconfigured, otherwise the dashboard.                         |
| `/sync-webdav settings` | Edits the WebDAV connection or the local push selection.                        |
| `/sync-webdav status`   | Checks that the remote folder is reachable and readable, and reports sync data. |
| `/sync-webdav diff`     | Previews the file changes the next push would make. Changes nothing.            |
| `/sync-webdav push`     | Uploads the selected local configuration.                                       |
| `/sync-webdav pull`     | Downloads and applies the remote configuration after confirmation.              |
| `/sync-webdav restore`  | Reapplies the most recent local backups created by a prior pull.                |

`status` and `diff` are read-only and can run non-interactively. `settings`, `push`, `pull`, and `restore` require an interactive Pi TUI.

## What syncs

Default push selection: `settings.json`, `keybindings.json`, `AGENTS.md`, `SYSTEM.md`, `APPEND_SYSTEM.md`, `models.json`, `themes/`, `prompts/`, `skills/`, `extensions/`.

Change the selection under **settings**. Directories sync recursively. The selection only affects `push`; `pull` always applies the full remote file set.

Never synced: `npm/`, `git/`, `pi-sync-webdav/`, `logs/`, `node_modules/`.

`sessions/` and `auth.json` are off by default. Adding one to the selection asks for an extra confirmation the first time; after that it stays approved. Treat everything you select—especially `auth.json`—as sensitive and only sync to a remote you trust.

## How sync works

- **push** publishes your currently selected local files to the dedicated remote folder.
- **pull** applies the remote file set, even if your local push selection is different. Review the planned additions, updates, and removals before confirming.
- Before pull replaces or removes a managed local file, it keeps a local backup of that file.
- **restore** reapplies those local file backups after confirmation. It does not restore a remote version and does not reinstall Pi packages.
- Backups live in `pi-sync-webdav/backups/` inside the Pi agent directory and mirror each file's original relative path. They hold the files replaced or removed by the most recent pull: the next pull that changes local files replaces the whole set, and restore leaves backups in place. To clear backups, delete that folder or single files inside it.
- This is not a remote backup-history service: there is no remote restore command.

## Remote access and safety

- HTTPS is required by default. HTTP needs an explicit warning confirmation. Self-signed or invalid TLS certificates are rejected.
- If the remote folder can be read but not written, the connection is saved as read-only. You can still use `status`, `diff`, and `pull`; `push` and residue cleanup are unavailable.
- Saving a connection only tests access—it never starts a push or pull.
- Long-running actions show progress and can be cancelled with Esc.
- For writable connections, the dashboard offers **Clean remote residue** to remove old sync data left by failed or cancelled attempts.

## Pi packages

`settings.json` can declare Pi packages (the extensions you install with `pi install`). During pull, those declarations are turned into install, update, or remove operations and shown for confirmation alongside file changes. Package install code runs with your user permissions, so pull only from a remote you trust.

If a package operation fails or is cancelled after files were pulled, the pulled files stay and you must resolve the package change manually.

## License

[MIT](LICENSE). See [CONTRIBUTING.md](CONTRIBUTING.md) to contribute.
